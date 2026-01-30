const GlockAppsService = require('./services/glockAppsService');
const PersonalSeedService = require('./services/personalSeedService');
const { checkDomainSecurity } = require('./dnsChecker');
const { sendEmail } = require('./emailService');
const fs = require('fs');
const path = require('path');

// Store API keys in a simple JSON file for now (in production, use encrypted DB)
const CONFIG_FILE = path.join(__dirname, 'services_config.json');

function loadConfig() {
    try {
        if (!fs.existsSync(CONFIG_FILE)) return {};
        return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    } catch (e) { return {}; }
}

function saveConfig(config) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// Map of provider names to their service classes
const PROVIDERS = {
    'glockapps': GlockAppsService,
    'personal': PersonalSeedService
};

class ExternalDeliverabilityManager {
    constructor() {
        this.activeTests = new Map();
    }

    getService(providerName) {
        const config = loadConfig();
        
        if (providerName === 'personal') {
            const seeds = config['personal']?.seeds || [];
            return new PersonalSeedService(seeds);
        }

        const apiKey = config[providerName]?.apiKey;
        const ServiceClass = PROVIDERS[providerName];
        if (!ServiceClass) throw new Error(`Provider ${providerName} not supported`);
        
        return new ServiceClass(apiKey);
    }

    /**
     * Step 1: Initialize a test with the external provider
     * Returns a seed list to send to.
     */
    async startTest(providerName) {
        const service = this.getService(providerName);
        // This calls the external API to get the seed list
        const { testId, seedList } = await service.createTest();
        
        // Store test info for personal checks
        if (providerName === 'personal') {
             this.activeTests.set(testId, { provider: 'personal', startTime: Date.now() });
        }

        return { testId, seedList };
    }

    /**
     * Step 2: Send emails to the seed list using our internal email service
     */
    async sendToSeedList(senderId, seedList, subject, content) {
        // We use the existing sendEmail function but target the seed list
        // Note: We might want to send individual emails to avoid showing all recipients
        
        const results = [];
        // Send individually to simulate real 1:1 outreach
        for (const seedEmail of seedList) {
            try {
                await sendEmail({
                    to: [seedEmail],
                    subject,
                    content,
                    selectedSenders: [senderId]
                });
                results.push({ email: seedEmail, status: 'sent' });
            } catch (error) {
                results.push({ email: seedEmail, status: 'error', error: error.message });
            }
            // Small delay to be polite
            await new Promise(r => setTimeout(r, 500)); 
        }

        // If personal test, store the subject so we can search for it later
        // We need to associate the subject with the latest test for this provider?
        // Actually, we pass subject to getTestStatus for personal
        
        return results;
    }

    /**
     * Step 3: Fetch results from the provider
     */
    async getTestStatus(providerName, testId, subject = null) {
        const service = this.getService(providerName);
        
        if (providerName === 'personal') {
            if (!subject) throw new Error('Subject required to check personal seeds');
            return await service.getTestResults(testId, subject);
        }

        return await service.getTestResults(testId);
    }

    saveApiKey(providerName, apiKey) {
        const config = loadConfig();
        config[providerName] = { apiKey };
        saveConfig(config);
    }
    
    savePersonalSeeds(seeds) {
        const config = loadConfig();
        config['personal'] = { seeds };
        saveConfig(config);
    }

    getApiKey(providerName) {
         const config = loadConfig();
         return config[providerName]?.apiKey || null;
    }

    getPersonalSeeds() {
        const config = loadConfig();
        return config['personal']?.seeds || [];
    }
}

module.exports = new ExternalDeliverabilityManager();
