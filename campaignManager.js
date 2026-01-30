const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'campaigns.json');

// Ensure DB file exists
if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify([], null, 2));
}

const getCampaigns = () => {
    try {
        const data = fs.readFileSync(DB_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error("Error reading campaigns:", error);
        return [];
    }
};

const saveCampaign = (campaign) => {
    try {
        const campaigns = getCampaigns();
        campaigns.unshift(campaign); // Add to top
        // Limit to last 1000 entries to prevent massive file
        if (campaigns.length > 1000) campaigns.length = 1000;
        fs.writeFileSync(DB_FILE, JSON.stringify(campaigns, null, 2));
        return true;
    } catch (error) {
        console.error("Error saving campaign:", error);
        return false;
    }
};

const updateCampaignStatus = (id, status, error = null) => {
    try {
        const campaigns = getCampaigns();
        const campaign = campaigns.find(c => c.id === id);
        if (campaign) {
            campaign.status = status;
            if (error) campaign.error = error;
            fs.writeFileSync(DB_FILE, JSON.stringify(campaigns, null, 2));
            return true;
        }
        return false;
    } catch (error) {
        console.error("Error updating campaign:", error);
        return false;
    }
};

module.exports = {
    getCampaigns,
    saveCampaign,
    updateCampaignStatus
};
