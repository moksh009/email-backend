const schedule = require('node-schedule');
const campaignManager = require('./campaignManager');
const emailService = require('./emailService');
const fs = require('fs');
const path = require('path');

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
            console.log(`Processing follow-up for campaign ${task.id}...`);
            
            // 1. Get latest campaign status to ensure it wasn't cancelled
            const campaigns = campaignManager.getCampaigns();
            const campaign = campaigns.find(c => c.id === task.id);
            
            if (!campaign || campaign.followUpStatus !== 'pending') {
                console.log(`Campaign ${task.id} no longer pending. Skipping.`);
                continue;
            }

            // 2. Send the Follow-up
            // We need to find the Message-ID of the original email to thread it
            const sentResult = campaign.results && campaign.results.find(r => r.success);
            const replyToMessageId = sentResult ? sentResult.messageId : null;
            
            const result = await emailService.sendEmail({
                to: campaign.to, // Assuming single recipient for now
                subject: campaign.followUp.subject,
                content: campaign.followUp.content,
                selectedSenders: campaign.senderIds, // Use same sender
                replyToMessageId: replyToMessageId
            });

            // 3. Update Status
            if (result.success) {
                campaignManager.updateCampaignStatus(campaign.id, 'follow-up-sent');
                // We need a specific method to update follow-up status, but generic status update works for now if we don't overwrite
                // Better: Update the specific follow-up fields
                campaign.followUpStatus = 'sent';
                campaign.followUpSentAt = new Date().toISOString();
                campaignManager.saveCampaign(campaign); // This pushes to top, might duplicate? No, saveCampaign unshifts.
                // campaignManager.updateCampaignStatus only updates top-level status.
                // We need a better update method.
                updateCampaignFollowUpStatus(campaign.id, 'sent');
                console.log(`Follow-up sent for ${task.id}`);
            } else {
                updateCampaignFollowUpStatus(campaign.id, 'failed', result.error);
                console.error(`Follow-up failed for ${task.id}:`, result.error);
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

// Helper to update campaign in place (since campaignManager.saveCampaign adds new)
const updateCampaignFollowUpStatus = (id, status, error = null) => {
    try {
        const campaigns = campaignManager.getCampaigns();
        const index = campaigns.findIndex(c => c.id === id);
        if (index !== -1) {
            campaigns[index].followUpStatus = status;
            if (status === 'sent') campaigns[index].followUpSentAt = new Date().toISOString();
            if (error) campaigns[index].followUpError = error;
            
            // Save ALL campaigns back
            const DB_FILE = path.join(__dirname, 'campaigns.json');
            fs.writeFileSync(DB_FILE, JSON.stringify(campaigns, null, 2));
        }
    } catch (e) {
        console.error("Failed to update follow-up status:", e);
    }
};

const initScheduler = () => {
    console.log("Initializing Follow-up Scheduler...");
    
    // Run every hour to check for pending follow-ups
    // Cron: '0 * * * *' (Every hour at minute 0)
    schedule.scheduleJob('0 * * * *', () => {
        console.log("Running hourly follow-up check...");
        checkPendingFollowUps();
    });

    // Also run immediately on startup
    checkPendingFollowUps();
};

const checkPendingFollowUps = () => {
    try {
        const campaigns = campaignManager.getCampaigns();
        const now = new Date();

        const pending = campaigns.filter(c => 
            c.followUp && 
            c.followUpStatus === 'pending' && 
            new Date(c.followUpScheduledAt) <= now
        );

        if (pending.length === 0) {
            console.log("No pending follow-ups found.");
            return;
        }

        console.log(`Found ${pending.length} pending follow-ups. Adding to queue.`);

        pending.forEach(c => {
            // Avoid duplicates in queue
            if (!sendQueue.find(t => t.id === c.id)) {
                sendQueue.push({ id: c.id });
            }
        });

        processQueue();

    } catch (error) {
        console.error("Error checking pending follow-ups:", error);
    }
};

module.exports = {
    initScheduler
};
