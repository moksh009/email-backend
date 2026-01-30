const fs = require('fs');
const path = require('path');
const { checkDomainSecurity } = require('./dnsChecker');

const STATS_FILE = path.join(__dirname, 'deliverability_stats.json');

// --- Helper: Load/Save ---
function loadStats() {
  try {
    if (!fs.existsSync(STATS_FILE)) return {};
    return JSON.parse(fs.readFileSync(STATS_FILE, 'utf-8'));
  } catch (err) {
    console.error('Error loading deliverability stats:', err);
    return {};
  }
}

function saveStats(stats) {
  try {
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
  } catch (err) {
    console.error('Error saving deliverability stats:', err);
  }
}

// --- Core Logic ---

// Initialize sender stats if missing
function initSenderStats(stats, senderId) {
  if (!stats[senderId]) {
    stats[senderId] = {
      totalSent: 0,
      totalBounces: 0,
      totalErrors: 0,
      history: [], // Keep last 1000 events for detailed analysis
      testSends: [], // Keep last 50 test sends for qualification
      warmupStatus: {
        stage: 1,
        startedAt: Date.now(),
        dailyCount: 0,
        lastSentDate: null
      }
    };
  }
  return stats[senderId];
}

/**
 * Log an email event
 * @param {string|number} senderId 
 * @param {'sent'|'bounce'|'error'|'test_success'|'test_spam'} type 
 * @param {object} meta 
 */
function logEmailEvent(senderId, type, meta = {}) {
  const stats = loadStats();
  const senderStats = initSenderStats(stats, senderId);
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

  saveStats(stats);
  return senderStats;
}

/**
 * Analyze Sender Qualification
 * Requirements:
 * - Min 95% primary inbox (last 50 tests)
 * - Max 2% spam (implied by above)
 * - Zero hard bounces (in recent history)
 */
async function checkQualification(senderId, domain) {
  const stats = loadStats();
  const senderStats = stats[senderId] || initSenderStats({}, senderId);
  
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
}

/**
 * Simulate a "Test Send" to a verification service
 * In a real app, this would ping a seed list API.
 * Here, we use heuristics + random sampling to simulate the ecosystem.
 */
async function runDeliverabilityTest(senderId, domain) {
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
  
  logEmailEvent(senderId, landedInPrimary ? 'test_success' : 'test_spam', {
    domain,
    score: finalScore.toFixed(1)
  });

  return {
    landedInPrimary,
    score: finalScore.toFixed(1),
    folder: landedInPrimary ? 'Primary' : 'Spam/Junk',
    provider: 'Gmail/Google Workspace (Simulated)'
  };
}

module.exports = {
  logEmailEvent,
  checkQualification,
  runDeliverabilityTest,
  loadStats
};
