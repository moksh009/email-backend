const GlockAppsService = require('./services/glockAppsService');
const PersonalSeedService = require('./services/personalSeedService');
const { checkDomainSecurity } = require('./dnsChecker');
const { sendEmail } = require('./emailService');
const supabase = require('./supabaseClient');

// Helper to get config from Supabase
async function getConfig(serviceName) {
    try {
        const { data, error } = await supabase
            .from('service_configs')
            .select('config')
            .eq('service_name', serviceName)
            .single();
        
        if (error || !data) return {};
        return data.config || {};
    } catch (e) {
        console.error(`Supabase getConfig(${serviceName}) exception:`, e);
        return {};
    }
}

// Helper to save config to Supabase
async function saveConfig(serviceName, config) {
    try {
        const { error } = await supabase.from('service_configs').upsert({
            service_name: serviceName,
            config: config
        });
        if (error) console.error(`Supabase saveConfig(${serviceName}) error:`, error);
    } catch (e) {
        console.error(`Supabase saveConfig(${serviceName}) exception:`, e);
    }
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

    async getService(providerName) {
        const config = await getConfig(providerName);
        
        if (providerName === 'personal') {
            const seeds = config.seeds || [];
            return new PersonalSeedService(seeds);
        }

        const apiKey = config.apiKey;
        const ServiceClass = PROVIDERS[providerName];
        if (!ServiceClass) throw new Error(`Provider ${providerName} not supported`);
        
        return new ServiceClass(apiKey);
    }

    /**
     * Step 1: Initialize a test with the external provider
     * Returns a seed list to send to.
     */
    async startTest(providerName) {
        const service = await this.getService(providerName);
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
        const service = await this.getService(providerName);
        // For personal service, we might need to pass the subject to search IMAP
        if (providerName === 'personal') {
             return await service.getTestResults(testId, subject);
        }
        return await service.getTestResults(testId);
    }

    // --- Configuration Management ---

    async getApiKey(providerName) {
        const config = await getConfig(providerName);
        return config.apiKey;
    }

    async saveApiKey(providerName, apiKey) {
        const config = await getConfig(providerName);
        config.apiKey = apiKey;
        await saveConfig(providerName, config);
    }

    async getPersonalSeeds() {
        const config = await getConfig('personal');
        return config.seeds || [];
    }

    async savePersonalSeeds(seeds) {
        const config = await getConfig('personal');
        config.seeds = seeds;
        await saveConfig('personal', config);
    }
}

module.exports = new ExternalDeliverabilityManager();
