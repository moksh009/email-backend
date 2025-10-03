const express = require('express');
const cors = require('cors');
const multer = require('multer');
require('dotenv').config();
const { sendEmail, scheduleEmail, getSendersList, initializeTransporters } = require('./emailService');

const app = express();
const port = process.env.PORT ? Number(process.env.PORT) : 3002;

// Configure CORS
app.use(cors({
  origin: process.env.CLIENT_ORIGINS ? process.env.CLIENT_ORIGINS.split(',').map(o => o.trim()) : ['http://localhost:5173', 'http://localhost:5174'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ ok: true, ts: Date.now(), port });
});

// Test endpoint
app.get('/', (req, res) => {
  res.json({ message: 'Email server is running' });
});

// Get available senders endpoint
app.get('/api/senders', (req, res) => {
  try {
    const senders = getSendersList();
    res.json(senders);
  } catch (error) {
    console.error('Error getting senders list:', error);
    res.status(500).json({ error: 'Failed to get senders list' });
  }
});

// Send email endpoint
app.post('/api/send-email', upload.array('attachments'), async (req, res) => {
  try {
    // Minimal logging for email request
    console.log(`Processing email to: ${req.body.to}`);
    
    const { to, subject, content } = req.body;
    
    // Validate required fields
    if (!to || !subject || !content) {
      return res.status(400).json({
        error: 'Missing required fields: to, subject, or content'
      });
    }

    // Parse recipients - handle both comma-separated and newline-separated emails
    const recipients = to.split(/[,\n]/).map(email => email.trim()).filter(email => email);
    let selectedSenders;
    
    try {
      selectedSenders = JSON.parse(req.body.selectedSenders || '[]');
      console.log('Parsed selected senders:', selectedSenders);
      
      if (!Array.isArray(selectedSenders) || selectedSenders.length === 0) {
        throw new Error('Please select at least one sender email');
      }
    } catch (e) {
      console.error('Error parsing selected senders:', e);
      return res.status(400).json({ 
        error: 'Invalid or missing sender selection. Please select a sender email.' 
      });
    }

    if (recipients.length === 0) {
      return res.status(400).json({ error: 'No recipients provided' });
    }

    // Prepare attachments
    const attachments = req.files?.map(file => ({
      filename: file.originalname,
      content: file.buffer,
      contentType: file.mimetype
    })) || [];

    const result = await sendEmail({
      to: recipients,
      subject,
      content,
      attachments,
      selectedSenders
    });

    res.json(result);
  } catch (error) {
    console.error('Email sending failed:', error.message);
    res.status(500).json({
      success: false,
      message: 'Failed to send email',
      error: error.message
    });
  }
});

// Schedule email endpoint
app.post('/api/schedule-email', upload.array('attachments'), async (req, res) => {
  try {
    console.log('Received schedule email request:', {
      to: req.body.to,
      subject: req.body.subject,
      scheduledTime: req.body.scheduledTime
    });

    const { subject, content, scheduledTime } = req.body;

    // Validate required fields
    if (!req.body.to || !subject || !content || !scheduledTime) {
      return res.status(400).json({ 
        error: 'Missing required fields: to, subject, content, or scheduledTime'
      });
    }

    // Parse recipients - handle both comma-separated and newline-separated emails
    const recipients = req.body.to.split(/[,\n]/).map(email => email.trim()).filter(email => email);
    const selectedSenders = [1];

    if (recipients.length === 0) {
      return res.status(400).json({ error: 'No valid recipients provided' });
    }

    // Prepare attachments
    const attachments = req.files?.map(file => ({
      filename: file.originalname,
      content: file.buffer,
      contentType: file.mimetype
    })) || [];

    const result = await scheduleEmail({
      to: recipients,
      subject,
      content,
      attachments,
      selectedSenders
    }, scheduledTime);

    res.json({ 
      message: 'Email scheduled successfully',
      details: {
        scheduledTime,
        totalRecipients: recipients.length,
        senderCount: selectedSenders.length,
        jobs: result.jobs
      },
      result
    });
  } catch (error) {
    console.error('Error scheduling email:', error);
    res.status(500).json({ 
      error: error.message || 'Failed to schedule email'
    });
  }
});

// (Removed unsubscribe and tracking endpoints per requirements)

// Deliverability check endpoint
app.get('/api/deliverability-check', (req, res) => {
  const warnings = [];
  const requiredEnv = ['PUBLIC_BASE_URL'];
  requiredEnv.forEach((k) => { if (!process.env[k]) warnings.push(`Missing env: ${k}`); });
  if (!process.env.DKIM_DOMAIN || !process.env.DKIM_SELECTOR || !process.env.DKIM_PRIVATE_KEY) {
    warnings.push('DKIM not configured (DKIM_DOMAIN, DKIM_SELECTOR, DKIM_PRIVATE_KEY).');
  }
  if (!process.env.SPF_STATUS) {
    warnings.push('SPF_STATUS not provided. Ensure SPF record exists for your domain.');
  }
  if (!process.env.DMARC_STATUS) {
    warnings.push('DMARC_STATUS not provided. Ensure DMARC record exists for your domain.');
  }
  res.json({ ok: warnings.length === 0, warnings });
});

// Error handling middleware
app.use((err, req, res, next) => {
  // Only log essential error information
  console.error('Error:', err.message);
  res.status(500).json({
    success: false,
    message: 'Internal server error'
  });
});

// Initialize email service and start server
async function startServer() {
  try {
    // Start the server first so it does not block on transporter initialization
    app.listen(port, () => {
      console.log(`Server is running on port ${port}`);
    });

    // Initialize email transporters in the background (non-blocking)
    initializeTransporters()
      .then(() => {
        console.log('Background initialization of transporters completed');
      })
      .catch((error) => {
        console.error('Background initialization error:', error.message || error);
      });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
