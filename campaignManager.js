const supabase = require('./supabaseClient');

// Helper to map DB row to Campaign object
const mapRowToCampaign = (row) => ({
    id: row.id,
    createdAt: row.created_at,
    subject: row.subject,
    content: row.content,
    recipients: row.recipients,
    senderIds: row.sender_ids,
    status: row.status,
    results: row.results,
    originalMessageId: row.original_message_id,
    isFollowUp: row.is_follow_up,
    followUp: row.follow_up_config,
    followUpStatus: row.follow_up_status,
    followUpSentAt: row.follow_up_sent_at,
    followUpError: row.follow_up_error,
    scheduledTime: row.scheduled_time
});

// Helper to map Campaign object to DB row
const mapCampaignToRow = (campaign) => ({
    id: campaign.id,
    created_at: campaign.createdAt,
    subject: campaign.subject,
    content: campaign.content,
    recipients: campaign.recipients,
    sender_ids: campaign.senderIds,
    status: campaign.status,
    results: campaign.results || [],
    original_message_id: campaign.originalMessageId,
    is_follow_up: campaign.isFollowUp,
    follow_up_config: campaign.followUp,
    follow_up_status: campaign.followUpStatus,
    follow_up_sent_at: campaign.followUpSentAt,
    follow_up_error: campaign.followUpError,
    scheduled_time: campaign.scheduledTime
});

const getCampaigns = async () => {
    try {
        const { data, error } = await supabase
            .from('campaigns')
            .select('*')
            .order('created_at', { ascending: false });
        
        if (error) {
            console.error("Supabase getCampaigns error:", error);
            return [];
        }
        return data.map(mapRowToCampaign);
    } catch (e) {
        console.error("Supabase getCampaigns exception:", e);
        return [];
    }
};

const saveCampaign = async (campaign) => {
    try {
        const row = mapCampaignToRow(campaign);
        const { error } = await supabase.from('campaigns').upsert(row);
        if (error) {
            console.error("Supabase saveCampaign error:", error);
            return false;
        }
        return true;
    } catch (e) {
        console.error("Supabase saveCampaign exception:", e);
        return false;
    }
};

const updateCampaignStatus = async (id, status, errorMsg = null) => {
    try {
        const updateData = { status };
        // If there's an error message, we might want to store it, but for now just status
        // In future, add an 'error' column to campaigns table if needed
        
        const { error } = await supabase.from('campaigns').update(updateData).eq('id', id);
        if (error) {
            console.error("Supabase updateCampaignStatus error:", error);
            return false;
        }
        return true;
    } catch (e) {
        console.error("Supabase updateCampaignStatus exception:", e);
        return false;
    }
};

const updateFollowUpStatus = async (id, status, errorMsg = null) => {
    try {
        const updateData = { follow_up_status: status };
        if (status === 'sent') updateData.follow_up_sent_at = new Date().toISOString();
        if (errorMsg) updateData.follow_up_error = errorMsg;
        
        const { error } = await supabase.from('campaigns').update(updateData).eq('id', id);
        if (error) {
            console.error("Supabase updateFollowUpStatus error:", error);
            return false;
        }
        return true;
    } catch (e) {
        console.error("Supabase updateFollowUpStatus exception:", e);
        return false;
    }
};

module.exports = {
    getCampaigns,
    saveCampaign,
    updateCampaignStatus,
    updateFollowUpStatus
};
