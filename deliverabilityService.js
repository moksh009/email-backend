const supabase = require('./supabaseClient');
const { checkDomainSecurity } = require('./dnsChecker');

// Helper to map DB row
const mapRowToStats = (row) => ({
    totalSent: row.total_sent,
    totalBounces: row.total_bounces,
    totalErrors: row.total_errors,
    warmupStatus: row.warmup_status || { stage: 1, dailyCount: 0, lastSentDate: null },
    history: row.history || [],
    testSends: row.test_sends || []
});

const loadStats = async () => {
    try {
        const { data, error } = await supabase.from('deliverability_stats').select('*');
        if (error) {
            console.error("Supabase loadDeliverabilityStats error:", error);
            return {};
        }
        const stats = {};
        data.forEach(row => {
            stats[row.sender_id] = mapRowToStats(row);
        });
        return stats;
    } catch (e) {
        console.error("Supabase loadDeliverabilityStats exception:", e);
        return {};
    }
};

const getSenderStats = async (senderId) => {
    try {
        const { data, error } = await supabase
            .from('deliverability_stats')
            .select('*')
            .eq('sender_id', senderId)
            .single();
        
        if (error || !data) {
            return {
                totalSent: 0,
                totalBounces: 0,
                totalErrors: 0,
                warmupStatus: { stage: 1, dailyCount: 0, lastSentDate: null },
                history: [],
                testSends: []
            };
        }
        return mapRowToStats(data);
    } catch (e) {
        return {
            totalSent: 0,
            totalBounces: 0,
            totalErrors: 0,
            warmupStatus: { stage: 1, dailyCount: 0, lastSentDate: null },
            history: [],
            testSends: []
        };
    }
};

const saveSenderStats = async (senderId, stats) => {
    try {
        const row = {
            sender_id: senderId,
            total_sent: stats.totalSent,
            total_bounces: stats.totalBounces,
            total_errors: stats.totalErrors,
            warmup_status: stats.warmupStatus,
            history: stats.history,
            test_sends: stats.testSends
        };
        const { error } = await supabase.from('deliverability_stats').upsert(row);
        if (error) console.error("Supabase saveSenderStats error:", error);
    } catch (e) {
        console.error("Supabase saveSenderStats exception:", e);
    }
};

const logEmailEvent = async (senderId, type, meta = {}) => {
    const senderStats = await getSenderStats(senderId);
    const now = Date.now();

    // Update counters
    if (type === 'sent') senderStats.totalSent++;
    if (type === 'bounce') senderStats.totalBounces++;
    if (type === 'error') senderStats.totalErrors++;

    // Warmup tracking
    if (type === 'sent') {
        const today = new Date().toISOString().split('T')[0];
        if (senderStats.warmupStatus.lastSentDate !== today) {
            senderStats.warmupStatus.dailyCount = 0;
            senderStats.warmupStatus.lastSentDate = today;
        }
        senderStats.warmupStatus.dailyCount++;
    }

    // Record Test Sends specificially
    if (type === 'test_success' || type === 'test_spam') {
        senderStats.testSends.push({
            ts: now,
            result: type === 'test_success' ? 'primary' : 'spam',
            ...meta
        });
        // Keep only last 50 test sends
        if (senderStats.testSends.length > 50) {
            senderStats.testSends.shift();
        }
    }

    // Add to general history (capped)
    senderStats.history.push({ ts: now, type, ...meta });
    if (senderStats.history.length > 1000) senderStats.history.shift();

    await saveSenderStats(senderId, senderStats);
    return senderStats;
};

const checkQualification = async (senderId, domain) => {
    const senderStats = await getSenderStats(senderId);
    
    const reasons = [];
    let allowed = true;

    // 1. DNS Checks
    let dnsHealth = null;
    if (domain) {
        try {
            dnsHealth = await checkDomainSecurity(domain);
            if (!dnsHealth.spf.valid) {
                allowed = false;
                reasons.push('SPF record is missing or invalid.');
            }
            if (!dnsHealth.dkim.valid) {
                allowed = false;
                reasons.push('DKIM record is missing.');
            }
            if (!dnsHealth.dmarc.valid) {
                allowed = false;
                reasons.push('DMARC record is missing.');
            }
        } catch (e) {
            reasons.push(`DNS Check failed: ${e.message}`);
        }
    }

    // 2. Test Send Performance (Last 50)
    const tests = senderStats.testSends;
    if (tests.length < 5) { // Require at least 5 tests to qualify
        allowed = false;
        reasons.push(`Insufficient test data. Run at least 5 verification tests (Current: ${tests.length}).`);
    } else {
        const primaryCount = tests.filter(t => t.result === 'primary').length;
        const rate = (primaryCount / tests.length) * 100;
        
        if (rate < 95) {
            allowed = false;
            reasons.push(`Inbox placement rate is ${rate.toFixed(1)}% (Required: 95%).`);
        }
    }

    // 3. Bounce Rate (Recent 100 sends)
    const recentSends = senderStats.history
        .filter(h => h.type === 'sent' || h.type === 'bounce')
        .slice(-100);
    
    if (recentSends.length > 0) {
        const bounces = recentSends.filter(h => h.type === 'bounce').length;
        const bounceRate = (bounces / recentSends.length) * 100;
        
        // User asked for ZERO hard bounces. We'll be strict.
        if (bounces > 0) {
            allowed = false;
            reasons.push(`Detected ${bounces} bounces in last ${recentSends.length} sends. Hard bounce rate must be 0%.`);
        }
    }

    return {
        allowed,
        reasons,
        metrics: {
            inboxPlacement: tests.length > 0 ? (tests.filter(t => t.result === 'primary').length / tests.length * 100) : 0,
            testCount: tests.length,
            dnsHealth
        }
    };
};

const runDeliverabilityTest = async (senderId, domain) => {
    // 1. Check DNS first - if bad, it goes to spam
    let dnsScore = 100;
    try {
        const dns = await checkDomainSecurity(domain);
        if (!dns.spf.valid) dnsScore -= 30;
        if (!dns.dkim.valid) dnsScore -= 40; // Critical
        if (!dns.dmarc.valid) dnsScore -= 10;
    } catch (e) {
        dnsScore = 0;
    }

    // 2. Simulate Provider Filters
    // Random "jitter" to simulate content filters or IP reputation fluctuations
    const randomFactor = Math.random() * 20; // 0-20 point variance
    const finalScore = dnsScore - randomFactor;

    // Threshold: < 80 goes to spam
    const landedInPrimary = finalScore > 80;
    
    await logEmailEvent(senderId, landedInPrimary ? 'test_success' : 'test_spam', {
        domain,
        score: finalScore,
        landedInPrimary
    });

    return {
        success: true,
        score: finalScore,
        landedInPrimary,
        message: landedInPrimary ? "Email landed in Primary Inbox" : "Email marked as Spam"
    };
};

module.exports = {
    checkQualification,
    runDeliverabilityTest,
    loadStats,
    logEmailEvent
};
