const nodemailer = require('nodemailer');
const schedule = require('node-schedule');
const dotenv = require('dotenv');
const { Pool } = require('pg');

// Load environment variables
dotenv.config();

// Store transporters for reuse
const transporters = {};
// Tracking and unsubscribe removed per requirements

// Get all available senders from environment variables
const getAvailableSenders = () => {
  const senders = [];
  let id = 1;

  // Keep checking for EMAIL_USER_X until we don't find any more
  while (process.env[`EMAIL_USER_${id}`]) {
    const user = process.env[`EMAIL_USER_${id}`];
    const pass = process.env[`EMAIL_PASSWORD_${id}`];

    if (user && pass) {
      senders.push({
        id,
        email: user,
        active: true
      });
    }

    id++;
  }

  if (senders.length === 0) {
    console.warn('No email senders configured');
  } else {
    console.log(`Found ${senders.length} configured senders`);
  }

  return senders;
};

const getTransporter = async (senderId) => {
  try {
    if (transporters[senderId]) {
      return transporters[senderId];
    }

    const user = process.env[`EMAIL_USER_${senderId}`];
    const pass = process.env[`EMAIL_PASSWORD_${senderId}`];

    if (!user || !pass) {
      throw new Error(`Invalid sender configuration for ID: ${senderId}`);
    }

    // Allow explicit SMTP configuration via env per-sender
    const explicitService = process.env[`SMTP_SERVICE_${senderId}`]; // e.g., 'gmail'
    const explicitHost = process.env[`SMTP_HOST_${senderId}`]; // e.g., 'smtp.gmail.com'
    const explicitPort = process.env[`SMTP_PORT_${senderId}`]; // e.g., '587' | '465'
    const explicitSecure = process.env[`SMTP_SECURE_${senderId}`]; // 'true' | 'false'

    // Determine provider heuristics
    const isGmailAddress = user.endsWith('@gmail.com');
    const forceGmail = (process.env[`USE_GMAIL_${senderId}`] || '').toLowerCase() === 'true'; // for Google Workspace

    let transporterConfig;
    const commonOptions = {
      connectionTimeout: 20000, // 20 seconds
      greetingTimeout: 30000,   // 30 seconds
      socketTimeout: 20000,     // 20 seconds
      pool: true,               // Use pooled connections
      maxConnections: 1,        // Reduce from 3 to 1 to stay under the radar
      maxMessages: 100,         // Refresh connection after 100 messages
      logger: true,             // Log to console
      debug: true               // Include SMTP traffic in logs
    };

    if (explicitService) {
      transporterConfig = {
        service: explicitService,
        auth: { user, pass },
        ...commonOptions
      };
    } else if (explicitHost) {
      transporterConfig = {
        host: explicitHost,
        port: explicitPort ? Number(explicitPort) : 587,
        secure: explicitSecure ? explicitSecure.toLowerCase() === 'true' : false,
        auth: { user, pass },
        tls: { rejectUnauthorized: false },
        ...commonOptions
      };
    } else if (isGmailAddress || forceGmail) {
      // Gmail / Google Workspace
      // Use Port 465 (SSL) which is often more reliable on Cloud Hosting than 587
      transporterConfig = {
        host: 'smtp.gmail.com',
        port: 465,
        secure: true, // SSL
        auth: { user, pass },
        ...commonOptions
      };
    } else {
      // Default to Hostinger if no overrides and not gmail-like
      // Fallback to Port 587 (STARTTLS) as Port 465 might be blocked by some cloud providers
      transporterConfig = {
        host: 'smtp.hostinger.com',
        port: 587,
        secure: false,
        auth: { user, pass },
        tls: {
          rejectUnauthorized: false
        },
        ...commonOptions
      };
    }

    // Optional DKIM configuration via env
    const dkimDomainName = process.env[`DKIM_DOMAIN_${senderId}`] || process.env.DKIM_DOMAIN;
    const dkimKeySelector = process.env[`DKIM_SELECTOR_${senderId}`] || process.env.DKIM_SELECTOR;
    const dkimPrivateKey = process.env[`DKIM_PRIVATE_KEY_${senderId}`] || process.env.DKIM_PRIVATE_KEY;

    if (dkimDomainName && dkimKeySelector && dkimPrivateKey) {
      transporterConfig.dkim = {
        domainName: dkimDomainName,
        keySelector: dkimKeySelector,
        privateKey: dkimPrivateKey
      };
    } else {
      // Check if the provider handles DKIM automatically (e.g., Gmail/Google Workspace)
      const isGoogle = 
        transporterConfig.service === 'gmail' || 
        transporterConfig.host === 'smtp.gmail.com';

      if (!isGoogle) {
        // Only warn for non-Google providers where manual DKIM might be needed
        console.warn(`[Sender ${senderId}] DKIM configuration missing. Emails may land in Spam.`);
      }
    }

    const transporter = nodemailer.createTransport(transporterConfig);

    // Verify the connection with timeout to avoid hangs
    // We NEED to verify the connection at startup to see if the port is blocked.
    // Use a race condition to fail fast if the host is blocking the port.
    await Promise.race([
      transporter.verify(),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Connection timeout: Port ${transporterConfig.port} might be blocked by your hosting provider (Render/AWS)`)), 10000))
    ]);

    transporters[senderId] = transporter;
    return transporter;
  } catch (error) {
    console.error(`Transporter error for sender ${senderId}:`, error.message);
    throw error;
  }
};

// Initialize all transporters with connection rate limiting
const initializeTransporters = async () => {
  try {
    const senders = getAvailableSenders();
    console.log(`Initializing transporters for senders:`, senders.map(s => s.email));
    
    if (senders.length === 0) {
      throw new Error('No email senders configured. Please check your .env file.');
    }

    const initPromises = senders.map(sender => getTransporter(sender.id));
    const results = await Promise.allSettled(initPromises);
    
    const successfulTransporters = results.filter(r => r.status === 'fulfilled' && r.value);
    
    if (successfulTransporters.length === 0) {
      throw new Error('Failed to initialize any email transporters. Please check your credentials.');
    }
    
    console.log(`Successfully initialized ${successfulTransporters.length} transporters`);
    return successfulTransporters;
  } catch (error) {
    console.error('Error in initializeTransporters:', error);
    throw error;
  }
};

// Helper function to convert plain text to HTML with proper line breaks
const textToHtml = (text) => {
  if (!text) return '';
  
  // Replace line breaks with <br> tags and preserve whitespace
  return text
    .replace(/\n/g, '<br>')
    .replace(/\s{2,}/g, space => ' ' + '&nbsp;'.repeat(space.length - 1));
};

// Helper function to convert HTML to plain text
const htmlToPlainText = (html) => {
  if (!html) return '';
  
  // Replace <br>, <p>, and other tags with appropriate line breaks
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<p>/gi, '')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\n\s*\n/g, '\n\n')
    .trim();
};

// Utility: create robust unique Message-ID
const createMessageId = (domain = 'gmail.com') => {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 15);
  return `<${timestamp}.${random}@${domain}>`;
};

const { logEmailEvent } = require('./deliverabilityService');

// Send email function
// Warm-up and throttling controls
// Default to 20 emails per minute (conservative) to land in Primary
const maxEmailsPerMinute = Number(process.env.MAX_EMAILS_PER_MINUTE || 20);
// Default to 2 seconds base delay + jitter
const perRecipientDelayMs = Number(process.env.PER_RECIPIENT_DELAY_MS || 2000);
let sentInCurrentWindow = 0;
let windowStartTs = Date.now();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const sendEmail = async ({ to, subject, content, attachments = [], selectedSenders = [], replyToMessageId = null }) => {
  try {
    if (!to || !subject || !content) {
      throw new Error('Missing required email fields');
    }

    const senders = selectedSenders.length > 0 ? selectedSenders : [1];
    const results = [];

    // Ensure content has proper HTML line breaks
    const htmlContent = content.includes('<br>') ? content : textToHtml(content);

    const allowedRecipients = to;

    for (const senderId of senders) {
      try {
        const transporter = await getTransporter(senderId);
        
        // Extract domain for Message-ID
        const senderEmail = process.env[`EMAIL_USER_${senderId}`];
        const senderDomain = senderEmail ? senderEmail.split('@')[1] : 'gmail.com';
        const messageId = createMessageId(senderDomain);
        
        // Headers for better deliverability & Threading
        const headers = {
          'X-Entity-Ref-ID': messageId,
          'Message-ID': messageId,
          'X-Mailer': 'Mailflow Client',
          'Precedence': 'bulk'
        };

        // Add Threading Headers if replying
        if (replyToMessageId) {
            headers['In-Reply-To'] = replyToMessageId;
            headers['References'] = replyToMessageId;
        }

        // Rate limiting window (simple token bucket)
        const now = Date.now();
        if (now - windowStartTs > 60_000) { windowStartTs = now; sentInCurrentWindow = 0; }
        if (sentInCurrentWindow >= maxEmailsPerMinute) {
          const waitMs = 60_000 - (now - windowStartTs);
          if (waitMs > 0) await sleep(waitMs);
          windowStartTs = Date.now();
          sentInCurrentWindow = 0;
        }

        // Add hidden hash buster to body to avoid exact content matching (spam filters hate 100% identical bodies)
        const hashBuster = `<!-- ${Math.random().toString(36).substring(7)} -->`;
        const finalHtml = `${htmlContent}\n${hashBuster}`;

        const result = await transporter.sendMail({
          from: senderEmail,
          to: allowedRecipients,
          subject,
          text: htmlToPlainText(content),
          html: finalHtml,
          headers,
          attachments,
          replyTo: process.env.REPLY_TO || senderEmail,
          envelope: {
            from: process.env.RETURN_PATH || senderEmail,
            to: Array.isArray(allowedRecipients) ? allowedRecipients : [allowedRecipients]
          }
        });
        
        sentInCurrentWindow += Array.isArray(allowedRecipients) ? allowedRecipients.length : 1;
        
        // SMART THROTTLING: Add Jitter (Randomness)
        // Mimics human behavior: Base delay + random(0-3000ms)
        if (perRecipientDelayMs > 0) {
          const jitter = Math.floor(Math.random() * 3000); 
          await sleep(perRecipientDelayMs + jitter);
        }
        
        // Log Success
        logEmailEvent(senderId, 'sent', { messageId });

        results.push({ senderId, success: true, messageId: result.messageId || messageId });
      } catch (error) {
        console.error(`Failed to send email using sender ${senderId}:`, error.message);
        
        // Log Failure
        logEmailEvent(senderId, 'error', { error: error.message });

        results.push({ senderId, success: false, error: error.message });
      }
    }

    return { success: true, results };
  } catch (error) {
    throw error;
  }
};

// Schedule email function
const scheduleEmail = async (emailData, scheduledTime, callbacks = {}) => {
  try {
    console.log('Scheduling email with data:', {
      recipientCount: emailData.to.length,
      subject: emailData.subject,
      selectedSenders: emailData.selectedSenders,
      scheduledTime
    });

    const scheduledDate = new Date(scheduledTime);
    if (isNaN(scheduledDate.getTime())) {
      throw new Error('Invalid scheduled time');
    }

    // Validate recipients
    if (!Array.isArray(emailData.to) || emailData.to.length === 0) {
      throw new Error('No recipients defined');
    }

    // Get selected senders or default to sender 1
    const selectedSenders = emailData.selectedSenders?.length > 0 
      ? emailData.selectedSenders 
      : [1];

    console.log('Using senders for scheduled email:', selectedSenders);

    // For scheduled emails, we'll use only the first selected sender
    const senderId = selectedSenders[0];
    console.log('Using primary sender for scheduled email:', senderId);

    const jobId = `email-${Date.now()}`;
    const jobs = [];

    // Schedule a single job for all recipients using the selected sender
    const htmlContent = textToHtml(emailData.content);
    const plainTextContent = emailData.content; // Keep original text with line breaks
    
    // Generate Message-ID for threading
    const senderEmail = process.env[`EMAIL_USER_${senderId}`];
    const senderDomain = senderEmail ? senderEmail.split('@')[1] : 'gmail.com';
    const messageId = createMessageId(senderDomain);

    const headers = {
        'X-Entity-Ref-ID': messageId,
        'Message-ID': messageId,
        'X-Mailer': 'Mailflow Client',
        'Precedence': 'bulk'
    };

    if (emailData.replyToMessageId) {
        headers['In-Reply-To'] = emailData.replyToMessageId;
        headers['References'] = emailData.replyToMessageId;
    }

    const mailOptions = {
      from: senderEmail,
      to: emailData.to.join(', '),
      subject: emailData.subject,
      html: htmlContent,
      text: plainTextContent,
      headers,
      attachments: (emailData.attachments || []).map(attachment => ({
        filename: attachment.filename || attachment.name,
        content: attachment.content || attachment.buffer,
        contentType: attachment.contentType || attachment.mimetype
      }))
    };

    const senderJobId = `${jobId}-sender-${senderId}`;
    
    const job = schedule.scheduleJob(scheduledDate, async () => {
      try {
        console.log(`Executing scheduled email from sender ${senderId} to:`, emailData.to);
        const transporter = await getTransporter(senderId);
        if (!transporter) {
          throw new Error(`Failed to get transporter for sender ${senderId}`);
        }
        const info = await transporter.sendMail(mailOptions);
        console.log(`Scheduled email from sender ${senderId} sent successfully:`, info);
        
        // Clean up the job after successful execution
        delete scheduledJobs[senderJobId];
        
        // Callback Success
        if (callbacks.onSuccess) callbacks.onSuccess(info);

      } catch (error) {
        console.error(`Error sending scheduled email from sender ${senderId}:`, error);
        // Callback Error
        if (callbacks.onError) callbacks.onError(error);
      }
    });

    if (job) {
      jobs.push({ 
        jobId: senderJobId, 
        senderId, 
        senderEmail,
        recipients: emailData.to 
      });
      
      scheduledJobs[senderJobId] = {
        job,
        senderId,
        senderEmail,
        recipients: emailData.to,
        scheduledTime: scheduledDate,
        mailOptions
      };
    }

    if (jobs.length === 0) {
      throw new Error('Failed to schedule any email jobs');
    }

    return { success: true, jobs, messageId }; // Return messageId so we can save it
  } catch (error) {
    throw error;
  }
};

// Store scheduled jobs
const scheduledJobs = {};

// Get list of senders with their status
const getSendersList = () => {
  const senders = getAvailableSenders();
  return senders.map(sender => ({
    id: sender.id,
    email: sender.email,
    active: sender.active
  }));
};

// Get all scheduled jobs
const getScheduledJobs = () => {
  return Object.entries(scheduledJobs).map(([jobId, job]) => ({
    jobId,
    senderId: job.senderId,
    senderEmail: job.senderEmail,
    scheduledTime: job.scheduledTime,
    recipients: job.recipients
  }));
};

// Cancel a scheduled job
const cancelScheduledJob = (jobId) => {
  const job = scheduledJobs[jobId];
  if (job) {
    job.job.cancel();
    delete scheduledJobs[jobId];
    return true;
  }
  return false;
};

let dbPool = null;
const initializeSchedulerDb = async () => {
  if (!process.env.DATABASE_URL) return false;
  dbPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false });
  await dbPool.query(`CREATE TABLE IF NOT EXISTS email_jobs (
    id BIGSERIAL PRIMARY KEY,
    sender_id INTEGER NOT NULL,
    recipients JSONB NOT NULL,
    subject TEXT NOT NULL,
    content TEXT NOT NULL,
    attachments JSONB,
    scheduled_time TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    last_attempt_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  return true;
};

const scheduleEmailPersistent = async (emailData, scheduledTime) => {
  if (!dbPool) throw new Error('DATABASE_URL not configured');
  const senders = emailData.selectedSenders?.length > 0 ? emailData.selectedSenders : [1];
  const senderId = senders[0];
  const attachments = (emailData.attachments || []).map(a => ({
    filename: a.filename || a.name,
    contentType: a.contentType || a.mimetype,
    content: Buffer.isBuffer(a.content || a.buffer) ? (a.content || a.buffer).toString('base64') : (a.content || '')
  }));
  const res = await dbPool.query(
    `INSERT INTO email_jobs (sender_id, recipients, subject, content, attachments, scheduled_time, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending')
     RETURNING id, scheduled_time`,
    [senderId, JSON.stringify(emailData.to), emailData.subject, emailData.content, JSON.stringify(attachments), new Date(scheduledTime)]
  );
  return { success: true, jobId: String(res.rows[0].id), scheduledTime: res.rows[0].scheduled_time };
};

const processDueScheduledEmails = async (limit = 20) => {
  if (!dbPool) return;
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, sender_id, recipients, subject, content, attachments
       FROM email_jobs
       WHERE status = 'pending' AND scheduled_time <= NOW()
       ORDER BY scheduled_time ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [limit]
    );
    for (const row of rows) {
      await client.query(`UPDATE email_jobs SET status = 'processing' WHERE id = $1`, [row.id]);
      try {
        const attachments = (row.attachments || []).map(a => ({
          filename: a.filename,
          contentType: a.contentType,
          content: a.content ? Buffer.from(a.content, 'base64') : undefined
        })).filter(x => x.filename);
        const transporter = await getTransporter(row.sender_id);
        await transporter.sendMail({
          from: process.env[`EMAIL_USER_${row.sender_id}`],
          to: Array.isArray(row.recipients) ? row.recipients.join(', ') : '',
          subject: row.subject,
          html: textToHtml(row.content),
          text: row.content,
          attachments
        });
        await client.query(
          `UPDATE email_jobs SET status = 'sent', last_attempt_at = NOW(), attempts = attempts + 1 WHERE id = $1`,
          [row.id]
        );
      } catch (err) {
        await client.query(
          `UPDATE email_jobs SET status = 'error', last_attempt_at = NOW(), attempts = attempts + 1 WHERE id = $1`,
          [row.id]
        );
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
};

// Export as CommonJS module
module.exports = {
  sendEmail,
  scheduleEmail,
  getScheduledJobs,
  cancelScheduledJob,
  getAvailableSenders,
  getSendersList,
  initializeTransporters,
  initializeSchedulerDb,
  scheduleEmailPersistent,
  processDueScheduledEmails
};
