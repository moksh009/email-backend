const fs = require('fs');
const path = require('path');

const STATS_FILE = path.join(__dirname, 'send_stats.json');

// --- Load stats from file ---
function loadStats() {
  try {
    if (!fs.existsSync(STATS_FILE)) return { bySenderDate: {} };
    const data = fs.readFileSync(STATS_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    console.error('Error reading stats file:', err);
    return { bySenderDate: {} };
  }
}

// --- Save stats to file ---
function saveStats(stats) {
  try {
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
  } catch (err) {
    console.error('Error writing stats file:', err);
  }
}

// --- Record a send for a sender today ---
function recordSend(senderId, count = 1, date = new Date()) {
  const stats = loadStats();
  const dateKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const key = `${senderId}:${dateKey}`;

  if (!stats.bySenderDate[key]) stats.bySenderDate[key] = 0;
  stats.bySenderDate[key] += count;

  saveStats(stats);
}

// --- Get stats in structured format for frontend ---
function getStructuredStats() {
  const stats = loadStats();
  const sendersMap = {}; // optional, if you want sender details

  const daily = {};
  const monthly = {};

  Object.entries(stats.bySenderDate).forEach(([key, count]) => {
    const [senderId, dateStr] = key.split(':');
    const [year, month] = dateStr.split('-');

    // Daily
    if (!daily[senderId]) daily[senderId] = [];
    daily[senderId].push({ date: dateStr, count });

    // Monthly
    const monthKey = `${year}-${month}`;
    if (!monthly[senderId]) monthly[senderId] = [];
    let monthEntry = monthly[senderId].find(m => m.month === monthKey);
    if (!monthEntry) {
      monthEntry = { month: monthKey, count: 0 };
      monthly[senderId].push(monthEntry);
    }
    monthEntry.count += count;
  });

  // Sort dates ascending
  Object.keys(daily).forEach(k => daily[k].sort((a, b) => a.date.localeCompare(b.date)));
  Object.keys(monthly).forEach(k => monthly[k].sort((a, b) => a.month.localeCompare(b.month)));

  return { daily, monthly, senders: Object.entries(sendersMap).map(([id, email]) => ({ id, email })) };
}

module.exports = { recordSend, getStructuredStats };