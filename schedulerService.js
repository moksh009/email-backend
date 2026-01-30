const schedule = require('node-schedule');
const campaignManager = require('./campaignManager');
const emailService = require('./emailService');

// Queue to manage rate limiting
const sendQueue = [];
let isProcessingQueue = false;

// Process the queue with random delays
const processQueue = async () => {
    if (isProcessingQueue || sendQueue.length === 0) return;

    isProcessingQueue = true;
    
    while (sendQueue.length > 0) {
        const task = sendQueue.shift();
        
        try {
            console.log(`Processing ${task.type || 'follow-up'} for campaign ${task.id}...`);
            
            // 1. Get latest campaign status
            const campaigns = await campaignManager.getCampaigns();
            const campaign = campaigns.find(c => c.id === task.id);
            
            if (!campaign) {
                console.log(`Campaign ${task.id} not found. Skipping.`);
                continue;
            }

            if (task.type === 'initial') {
                if (campaign.status !== 'scheduled') {
                    console.log(`Campaign ${task.id} no longer scheduled (status: ${campaign.status}). Skipping.`);
                    continue;
                }

                // Send Initial Email
                console.log(`Sending initial scheduled email for ${task.id}`);
                const result = await emailService.sendEmail({
                    to: campaign.recipients,
                    subject: campaign.subject,
                    content: campaign.content,
                    selectedSenders: campaign.senderIds,
                    replyToMessageId: campaign.originalMessageId // Should be null usually
                });

                if (result.success) {
                    await campaignManager.updateCampaignStatus(campaign.id, 'sent');
                    console.log(`Scheduled email sent for ${task.id}`);
                } else {
                    await campaignManager.updateCampaignStatus(campaign.id, 'failed', result.error);
                    console.error(`Scheduled email failed for ${task.id}:`, result.error);
                }

            } else {
                // Handle Follow-up (existing logic)
                if (campaign.followUpStatus !== 'pending') {
                    console.log(`Campaign ${task.id} follow-up no longer pending. Skipping.`);
                    continue;
                }

                const sentResult = campaign.results && campaign.results.find(r => r.success);
                const replyToMessageId = sentResult ? sentResult.messageId : null;
                
                const result = await emailService.sendEmail({
                    to: campaign.recipients,
                    subject: campaign.followUp.subject,
                    content: campaign.followUp.content,
                    selectedSenders: campaign.senderIds,
                    replyToMessageId: replyToMessageId
                });

                if (result.success) {
                    await campaignManager.updateFollowUpStatus(campaign.id, 'sent');
                    console.log(`Follow-up sent for ${task.id}`);
                } else {
                    await campaignManager.updateFollowUpStatus(campaign.id, 'failed', result.error);
                    console.error(`Follow-up failed for ${task.id}:`, result.error);
                }
            }

        } catch (error) {
            console.error(`Error processing follow-up task ${task.id}:`, error);
        }

        // Random delay between 5 to 10 minutes (300000 to 600000 ms)
        // For testing, we might want shorter, but user asked for 5-10 mins.
        const delay = Math.floor(Math.random() * (600000 - 300000 + 1) + 300000);
        console.log(`Waiting ${delay / 1000 / 60} minutes before next email...`);
        await new Promise(resolve => setTimeout(resolve, delay));
    }

    isProcessingQueue = false;
};

const initScheduler = () => {
    console.log("Initializing Follow-up Scheduler...");
    
    // Run every hour to check for pending follow-ups
    // Cron: '0 * * * *' (Every hour at minute 0)
    schedule.scheduleJob('0 * * * *', async () => {
        console.log("Running scheduled check for follow-ups...");
        try {
            const campaigns = await campaignManager.getCampaigns();
            const now = new Date();
            
            // Find pending follow-ups due now
            const pending = campaigns.filter(c => {
                if (c.followUpStatus !== 'pending') return false;
                if (!c.followUpScheduledAt) return false;
                
                const scheduledTime = new Date(c.followUpScheduledAt);
                return scheduledTime <= now;
            });

            if (pending.length > 0) {
                console.log(`Found ${pending.length} pending follow-ups. Adding to queue...`);
                pending.forEach(c => sendQueue.push({ id: c.id }));
                processQueue();
            }
        } catch (e) {
            console.error("Scheduler error:", e);
        }
    });
};

module.exports = { initScheduler };
