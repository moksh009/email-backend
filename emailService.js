const nodemailer = require('nodemailer');
const schedule = require('node-schedule');
const dotenv = require('dotenv');

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
    if (explicitService) {
      transporterConfig = {
        service: explicitService,
        auth: { user, pass }
      };
    } else if (explicitHost) {
      transporterConfig = {
        host: explicitHost,
        port: explicitPort ? Number(explicitPort) : 587,
        secure: explicitSecure ? explicitSecure.toLowerCase() === 'true' : false,
        auth: { user, pass },
        tls: { rejectUnauthorized: false }
      };
    } else if (isGmailAddress || forceGmail) {
      // Gmail / Google Workspace
      transporterConfig = {
        host: 'smtp.gmail.com',
        port: 587,
        secure: false, // STARTTLS
        auth: { user, pass }
      };
    } else {
      // Default to Hostinger if no overrides and not gmail-like
      transporterConfig = {
        host: 'smtp.hostinger.com',
        port: 587,
        secure: false,
        auth: { user, pass },
        tls: {
          rejectUnauthorized: false
        }
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
    }

    const transporter = nodemailer.createTransport(transporterConfig);

    // Verify the connection with timeout to avoid hangs
    await Promise.race([
      transporter.verify(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('SMTP verify timeout')), 8000))
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

// Utility: create simple unique id
const createMessageId = () => `mmmmaail-${Date.now()}-${Math.random().toString(36).slice(2)}`;

// Send email function
// Warm-up and throttling controls
const maxEmailsPerMinute = Number(process.env.MAX_EMAILS_PER_MINUTE || 30);
const perRecipientDelayMs = Number(process.env.PER_RECIPIENT_DELAY_MS || 0);
let sentInCurrentWindow = 0;
let windowStartTs = Date.now();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const sendEmail = async ({ to, subject, content, attachments = [], selectedSenders = [] }) => {
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
        const messageId = createMessageId();
        const headers = { 'X-Entity-Ref-ID': messageId };

        // Rate limiting window (simple token bucket)
        const now = Date.now();
        if (now - windowStartTs > 60_000) { windowStartTs = now; sentInCurrentWindow = 0; }
        if (sentInCurrentWindow >= maxEmailsPerMinute) {
          const waitMs = 60_000 - (now - windowStartTs);
          if (waitMs > 0) await sleep(waitMs);
          windowStartTs = Date.now();
          sentInCurrentWindow = 0;
        }

        const result = await transporter.sendMail({
          from: process.env[`EMAIL_USER_${senderId}`],
          to: allowedRecipients,
          subject,
          text: htmlToPlainText(content),
          html: htmlContent,
          headers,
          attachments,
          replyTo: process.env.REPLY_TO || process.env[`EMAIL_USER_${senderId}`],
          envelope: {
            from: process.env.RETURN_PATH || process.env[`EMAIL_USER_${senderId}`],
            to: Array.isArray(allowedRecipients) ? allowedRecipients : [allowedRecipients]
          }
        });
        sentInCurrentWindow += Array.isArray(allowedRecipients) ? allowedRecipients.length : 1;
        if (perRecipientDelayMs > 0) await sleep(perRecipientDelayMs);
        results.push({ senderId, success: true, messageId: result.messageId || messageId });
      } catch (error) {
        console.error(`Failed to send email using sender ${senderId}:`, error.message);
        results.push({ senderId, success: false, error: error.message });
      }
    }

    return { success: true, results };
  } catch (error) {
    throw error;
  }
};

// Schedule email function
const scheduleEmail = async (emailData, scheduledTime) => {
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
    
    const mailOptions = {
      from: process.env[`EMAIL_USER_${senderId}`],
      to: emailData.to.join(', '),
      subject: emailData.subject,
      html: htmlContent,
      text: plainTextContent,
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
      } catch (error) {
        console.error(`Error sending scheduled email from sender ${senderId}:`, error);
      }
    });

    if (job) {
      jobs.push({ 
        jobId: senderJobId, 
        senderId, 
        senderEmail: process.env[`EMAIL_USER_${senderId}`],
        recipients: emailData.to 
      });
      
      scheduledJobs[senderJobId] = {
        job,
        senderId,
        senderEmail: process.env[`EMAIL_USER_${senderId}`],
        recipients: emailData.to,
        scheduledTime: scheduledDate,
        mailOptions
      };
    }

    if (jobs.length === 0) {
      throw new Error('Failed to schedule any email jobs');
    }

    console.log('Successfully scheduled email jobs:', jobs);
    return {
      success: true,
      jobId,
      scheduledTime: scheduledDate,
      jobs: jobs.map(j => ({
        jobId: j.jobId,
        senderId: j.senderId,
        senderEmail: j.senderEmail,
        recipientCount: j.recipients.length
      }))
    };
  } catch (error) {
    console.error('Error scheduling email:', error);
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

// Export as CommonJS module
module.exports = {
  sendEmail,
  scheduleEmail,
  getScheduledJobs,
  cancelScheduledJob,
  getAvailableSenders,
  getSendersList,
  initializeTransporters
};
