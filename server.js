const express = require('express');
const cors = require('cors');
const multer = require('multer');
const dns = require('dns').promises;
const net = require('net');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// Optional email service
let emailService = {};
try {
  emailService = require('./emailService');
} catch (e) {
  console.warn('emailService not found – send endpoints disabled');
}

const { sendEmail, scheduleEmail, getSendersList, initializeTransporters } = emailService;

// Optional verification service
let verificationModule = {};
try {
  verificationModule = require('./verificationService');
} catch (e) {
  console.warn('verificationService not found');
}

// Stats manager (file-based)
const { recordSend, getStructuredStats } = require('./statsManager');
const { checkDomainSecurity } = require('./dnsChecker');
const { 
  checkQualification, 
  runDeliverabilityTest, 
  loadStats: loadDeliverabilityStats 
} = require('./deliverabilityService');

const externalDeliverability = require('./externalDeliverabilityService');

// Dynamic AI Service Selection
const geminiService = require('./geminiService');
const groqService = require('./groqService');
const { generateEmailPrompt, generateFollowUpPrompt } = require('./prompts');
const campaignManager = require('./campaignManager');

// Debug Env Vars (Masked)
console.log("--- ENV DEBUG ---");
console.log("GROQ_API_KEY:", process.env.GROQ_API_KEY ? `Starts with ${process.env.GROQ_API_KEY.substring(0, 4)}...` : 'UNDEFINED');
console.log("GEMINI_API_KEY:", process.env.GEMINI_API_KEY ? `Starts with ${process.env.GEMINI_API_KEY.substring(0, 4)}...` : 'UNDEFINED');
console.log("-----------------");

// Helper to choose AI provider
const generateEmail = async (prompt, provider) => {
    // 1. Explicit Choice
    if (provider === 'groq') {
        if (!process.env.GROQ_API_KEY) throw new Error("Groq API Key not configured");
        return await groqService.generateEmail(prompt);
    }
    
    if (provider === 'gemini') {
        try {
            return await geminiService.generateEmail(prompt);
        } catch (error) {
            // Fallback to Groq if Gemini fails explicitly
            console.warn("Gemini failed, falling back to Groq...", error.message);
            if (process.env.GROQ_API_KEY) {
                return await groqService.generateEmail(prompt);
            }
            throw error;
        }
    }

    // 2. Default Auto-Selection (Prefer Groq for speed, Gemini for backup)
    if (process.env.GROQ_API_KEY) {
        try {
            return await groqService.generateEmail(prompt);
        } catch (error) {
            console.warn("Groq failed, falling back to Gemini...", error.message);
            // Fallback to Gemini
            return await geminiService.generateEmail(prompt);
        }
    }
    
    // Only Gemini available
    return await geminiService.generateEmail(prompt);
};

const app = express();

/* =========================
   MIDDLEWARE
========================= */

app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? (process.env.FRONTEND_URL ? [process.env.FRONTEND_URL] : '*') 
    : ['http://localhost:5173', 'http://localhost:5174'],
  credentials: true
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

/* =========================
   EXTERNAL DELIVERABILITY (Real-World)
========================= */

// Get configured API key or Personal Seeds
app.get('/api/deliverability/config/:provider', (req, res) => {
    if (req.params.provider === 'personal') {
        const seeds = externalDeliverability.getPersonalSeeds();
        return res.json({ hasKey: seeds.length > 0, seeds });
    }
    const key = externalDeliverability.getApiKey(req.params.provider);
    res.json({ hasKey: !!key });
});

// Save API key or Personal Seeds
app.post('/api/deliverability/config/:provider', (req, res) => {
    if (req.params.provider === 'personal') {
        const { seeds } = req.body;
        externalDeliverability.savePersonalSeeds(seeds);
        return res.json({ success: true });
    }
    const { apiKey } = req.body;
    externalDeliverability.saveApiKey(req.params.provider, apiKey);
    res.json({ success: true });
});

// Start a real-world test
app.post('/api/deliverability/external-test/start', async (req, res) => {
    try {
        const { provider = 'glockapps', senderId, subject, content } = req.body;
        
        // 1. Get Seed List from Provider
        const { testId, seedList } = await externalDeliverability.startTest(provider);
        
        // 2. Send emails to seed list (background process or immediate)
        // For now, we await it to ensure it's done, but in prod this should be a job
        const sendResults = await externalDeliverability.sendToSeedList(senderId, seedList, subject, content);
        
        res.json({ 
            testId, 
            seedCount: seedList.length,
            sendResults: sendResults.length 
        });
    } catch (error) {
        console.error('External Test Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get results
app.get('/api/deliverability/external-test/:id', async (req, res) => {
    try {
        const { provider = 'glockapps', subject } = req.query;
        // Pass subject for personal seed search
        const results = await externalDeliverability.getTestStatus(provider, req.params.id, subject);
        res.json(results);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const PORT = Number(process.env.PORT) || 3002;

/* =========================
   BASIC ROUTES
========================= */

app.get('/', (req, res) => {
  res.json({ message: 'Email server running', port: PORT });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

/* =========================
   SENDERS
========================= */

app.get('/api/check-dns', async (req, res) => {
  const { domain, selector } = req.query;
  if (!domain) {
    return res.status(400).json({ error: 'Domain is required' });
  }
  try {
    const results = await checkDomainSecurity(domain, selector);
    res.json(results);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/senders', (req, res) => {
  if (typeof getSendersList === 'function') {
    return res.json(getSendersList());
  }
  res.json([]);
});

/* =========================
   SEND EMAIL
========================= */

app.post('/api/send-email', upload.array('attachments'), async (req, res) => {
  if (!sendEmail) {
    return res.status(501).json({ error: 'Email service not configured' });
  }

  try {
    const { to, subject, content, selectedSenders } = req.body;

    if (!to || !subject || !content) {
      return res.status(400).json({ error: 'Missing fields' });
    }

    const recipients = to.split(/[,\n]/).map(e => e.trim()).filter(Boolean);
    const senders = JSON.parse(selectedSenders || '[]');

    if (!Array.isArray(senders) || !senders.length) {
      return res.status(400).json({ error: 'No sender selected' });
    }

    const attachments = req.files?.map(f => ({
      filename: f.originalname,
      content: f.buffer,
      contentType: f.mimetype
    })) || [];

    // Enforce Deliverability Qualification
    // Unless explicitly bypassed (e.g. for manual tests)
    const bypassCheck = req.body.bypassQualification === true || req.body.bypassQualification === 'true';
    
    // TEMPORARY: Allow all sends for now if qualification fails
    // This allows the "Direct Compose" feature to work while user fixes DNS
    if (!bypassCheck) {
      // Check first sender (primary)
      const primarySender = senders[0];
      const sendersList = getSendersList();
      const senderObj = sendersList.find(s => s.id == primarySender);
      const domain = senderObj ? senderObj.email.split('@')[1] : 'gmail.com';

      const qualification = await checkQualification(primarySender, domain);
      
      if (!qualification.allowed) {
        console.warn(`[WARNING] Sender ${primarySender} failed qualification but allowing send.`);
        console.warn('Reasons:', qualification.reasons);
        // return res.status(403).json({
        //   error: 'Outreach Blocked: Deliverability criteria not met.',
        //   reasons: qualification.reasons,
        //   details: qualification.metrics
        // });
      }
    }

    // Send email using configured service
    const result = await sendEmail({
      to: recipients,
      subject,
      content,
      attachments,
      selectedSenders: senders,
      replyToMessageId: req.body.replyToMessageId // Pass threading ID
    });

    // Save to Campaign History
    const campaignData = {
        id: Date.now().toString(), // Simple ID
        createdAt: new Date().toISOString(),
        subject,
        content,
        recipients,
        senderIds: senders,
        status: 'sent',
        results: result.results, // Contains Message-IDs
        originalMessageId: req.body.replyToMessageId || (result.results[0] ? result.results[0].messageId : null),
        isFollowUp: !!req.body.replyToMessageId
    };
    campaignManager.saveCampaign(campaignData);

    // Record stats for each sender (file-based)
    senders.forEach(senderId => {
      recordSend(senderId, recipients.length);
    });

    res.json(result);
  } catch (err) {
    console.error('Send error:', err);
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   SCHEDULE EMAIL
========================= */

app.post('/api/schedule-email', upload.array('attachments'), async (req, res) => {
  if (!scheduleEmail) {
    return res.status(501).json({ error: 'Scheduling service not configured' });
  }

  try {
    const { to, subject, content, selectedSenders, scheduledTime, replyToMessageId } = req.body;

    if (!to || !subject || !content || !scheduledTime) {
      return res.status(400).json({ error: 'Missing fields' });
    }

    const recipients = to.split(/[,\n]/).map(e => e.trim()).filter(Boolean);
    const senders = JSON.parse(selectedSenders || '[]');

    const attachments = req.files?.map(f => ({
      filename: f.originalname,
      content: f.buffer,
      contentType: f.mimetype
    })) || [];

    // Save initial campaign as 'scheduled'
    const campaignId = Date.now().toString();
    const campaignData = {
        id: campaignId,
        createdAt: new Date().toISOString(),
        subject,
        content,
        recipients,
        senderIds: senders,
        status: 'scheduled',
        scheduledTime,
        results: [],
        originalMessageId: replyToMessageId || null,
        isFollowUp: !!replyToMessageId
    };
    campaignManager.saveCampaign(campaignData);

    const result = await scheduleEmail({
      to: recipients,
      subject,
      content,
      attachments,
      selectedSenders: senders,
      replyToMessageId
    }, scheduledTime, {
        onSuccess: (info) => {
            console.log("Scheduled email sent! Updating DB...");
            campaignManager.updateCampaignStatus(campaignId, 'sent');
        },
        onError: (err) => {
            console.error("Scheduled email failed! Updating DB...");
            campaignManager.updateCampaignStatus(campaignId, 'failed', err.message);
        }
    });

    res.json(result);

  } catch (err) {
    console.error('Schedule error:', err);
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   VERIFY EMAILS
========================= */

app.post('/api/verify-emails', async (req, res) => {
  try {
    const { emails, safeSmtp } = req.body;

    if (!Array.isArray(emails) || emails.length === 0) {
      return res.status(400).json({ error: 'emails array required' });
    }

    if (typeof verificationModule.verifyEmailsBatch === 'function') {
      const result = await verificationModule.verifyEmailsBatch(emails, {
        safeSmtp: safeSmtp !== false
      });
      return res.json(result);
    }

    res.status(500).json({ error: 'Verification service unavailable' });
  } catch (err) {
    console.error('Verification error:', err);
    res.status(500).json({ error: 'Verification failed' });
  }
});

/* =========================
   STATS ENDPOINT
========================= */

app.get('/api/stats', (req, res) => {
  try {
    const structuredStats = getStructuredStats();
    res.json(structuredStats);
  } catch (err) {
    console.error('Failed to get stats', err);
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

/* =========================
   DELIVERABILITY & QUALIFICATION
========================= */

app.get('/api/deliverability/stats', (req, res) => {
  try {
    const stats = loadDeliverabilityStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/deliverability/qualify', async (req, res) => {
  const { senderId, domain } = req.query;
  if (!senderId) return res.status(400).json({ error: 'Sender ID required' });
  
  try {
    const result = await checkQualification(senderId, domain || 'gmail.com');
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/deliverability/test-send', async (req, res) => {
  const { senderId, domain } = req.body;
  if (!senderId || !domain) return res.status(400).json({ error: 'Sender ID and Domain required' });

  try {
    // Run a simulated test send
    const result = await runDeliverabilityTest(senderId, domain);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   AI AUTOMATION
========================= */

app.post('/api/ai/generate', async (req, res) => {
    try {
        const { lead, serviceType, provider } = req.body;
        
        if (!lead || !serviceType) {
            return res.status(400).json({ error: 'Missing lead data or service type' });
        }

        const prompt = generateEmailPrompt(lead, serviceType);
        const result = await generateEmail(prompt, provider);

        res.json(result);
    } catch (error) {
        console.error("AI Generation Error:", error);
        res.status(500).json({ error: error.message });
    }
});

/* =========================
   CAMPAIGN HISTORY & FOLLOW-UPS
========================= */

app.get('/api/history', (req, res) => {
    res.json(campaignManager.getCampaigns());
});

app.post('/api/ai/generate-followup', async (req, res) => {
    try {
        const { originalEmailId, serviceType, provider } = req.body;
        
        // Find original email
        const campaigns = campaignManager.getCampaigns();
        const original = campaigns.find(c => c.id === originalEmailId);
        
        if (!original) {
            return res.status(404).json({ error: 'Original email not found in history' });
        }

        // Construct context from original email
        // We assume the first recipient's context is what we want if it was a bulk send, 
        // but typically personalized follow-ups should be per-lead.
        // For now, we'll generate ONE follow-up content based on the stored content.
        
        // Extract Lead Name/Company from content if possible, or pass it in body.
        // Better: The user should probably re-supply lead details or we store them.
        // Since we stored 'recipients' as array of strings (emails), we might miss names.
        // FIX: Update saveCampaign to store full lead details if available? 
        // For now, we'll use a generic "Lead" name or try to parse.
        
        const lead = { name: "Lead", industry: "General" }; // Fallback

        const prompt = generateFollowUpPrompt(
            original.subject, 
            original.content, 
            lead, 
            serviceType || 'voice_agent'
        );

        const result = await generateEmail(prompt, provider);
        
        // Return generated content AND the messageId to reply to
        // We need the Message-ID of the successfully sent original email.
        // result.results is array of { success, messageId }
        const sentResult = original.results.find(r => r.success);
        const replyToMessageId = sentResult ? sentResult.messageId : null;

        res.json({ 
            ...result, 
            replyToMessageId,
            originalSubject: original.subject
        });

    } catch (error) {
        console.error("Follow-up Gen Error:", error);
        res.status(500).json({ error: error.message });
    }
});


/* =========================
   ERROR HANDLER
========================= */

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

/* =========================
   START SERVER
========================= */

app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
  if (typeof initializeTransporters === 'function') {
    initializeTransporters().catch(e =>
      console.error('Transport init error:', e.message)
    );
  }
});