const imaps = require('imap-simple');

/**
 * Personal Seed Service
 * 
 * Handles connecting to user-provided email accounts (Gmail/Outlook) via IMAP
 * to check if a test email landed in Inbox or Spam.
 */
class PersonalSeedService {
    constructor(seeds = []) {
        this.seeds = seeds; // Array of { email, password, host, port, secure }
    }

    /**
     * "Creating a test" in this context just means returning the list of seeds
     * we are configured to check.
     */
    async createTest() {
        if (!this.seeds || this.seeds.length === 0) {
            throw new Error('No personal seed accounts configured');
        }

        // Return a virtual test ID and the list of emails to send to
        return {
            testId: `personal-${Date.now()}`,
            seedList: this.seeds.map(s => s.email)
        };
    }

    /**
     * Connects to each seed account and searches for the email
     * by subject or time window.
     */
    async getTestResults(testId, subject) {
        const results = {
            id: testId,
            status: 'finished',
            placement: { inbox: 0, spam: 0, missing: 0 },
            breakdown: []
        };

        const checks = this.seeds.map(seed => this.checkSingleSeed(seed, subject));
        const checkResults = await Promise.all(checks);

        // Aggregate results
        let inboxCount = 0;
        let spamCount = 0;
        let missingCount = 0;

        checkResults.forEach(res => {
            if (res.folder === 'inbox') inboxCount++;
            else if (res.folder === 'spam') spamCount++;
            else missingCount++;

            results.breakdown.push({
                name: res.email, // Use email as name since it's personal
                inbox: res.folder === 'inbox' ? 100 : 0,
                spam: res.folder === 'spam' ? 100 : 0,
                status: res.folder
            });
        });

        const total = this.seeds.length;
        results.placement.inbox = Math.round((inboxCount / total) * 100);
        results.placement.spam = Math.round((spamCount / total) * 100);
        results.placement.missing = Math.round((missingCount / total) * 100);

        return results;
    }

    async checkSingleSeed(seed, subject) {
        const config = {
            imap: {
                user: seed.email,
                password: seed.password,
                host: seed.host || this.detectHost(seed.email),
                port: seed.port || 993,
                tls: true,
                authTimeout: 10000
            }
        };

        try {
            const connection = await imaps.connect(config);
            
            // 1. Check Inbox
            await connection.openBox('INBOX');
            const searchCriteria = [['HEADER', 'SUBJECT', subject]];
            const fetchOptions = { bodies: ['HEADER'], markSeen: false };
            
            const inboxMessages = await connection.search(searchCriteria, fetchOptions);
            if (inboxMessages.length > 0) {
                connection.end();
                return { email: seed.email, folder: 'inbox' };
            }

            // 2. Check Spam (Folder names vary: 'Spam', 'Junk', '[Gmail]/Spam')
            const spamFolder = this.detectSpamFolder(seed.email);
            try {
                await connection.openBox(spamFolder);
                const spamMessages = await connection.search(searchCriteria, fetchOptions);
                connection.end();
                
                if (spamMessages.length > 0) {
                    return { email: seed.email, folder: 'spam' };
                }
            } catch (err) {
                console.warn(`Could not open spam folder ${spamFolder} for ${seed.email}`, err.message);
                connection.end();
            }

            return { email: seed.email, folder: 'missing' };

        } catch (error) {
            console.error(`IMAP Error for ${seed.email}:`, error.message);
            return { email: seed.email, folder: 'error', error: error.message };
        }
    }

    detectHost(email) {
        if (email.includes('@gmail.com')) return 'imap.gmail.com';
        if (email.includes('@outlook.com') || email.includes('@hotmail.com')) return 'outlook.office365.com';
        if (email.includes('@yahoo.com')) return 'imap.mail.yahoo.com';
        return 'imap.gmail.com'; // Default fallback
    }

    detectSpamFolder(email) {
        if (email.includes('@gmail.com')) return '[Gmail]/Spam';
        if (email.includes('@yahoo.com')) return 'Bulk';
        return 'Junk'; // Standard for Outlook/others
    }
}

module.exports = PersonalSeedService;
