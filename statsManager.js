const supabase = require('./supabaseClient');

// --- Record a send for a sender today ---
const recordSend = async (senderId, count = 1, date = new Date()) => {
    try {
        const dateStr = date.toISOString().split('T')[0];
        
        // Upsert requires checking existing or using onConflict
        // Since we want to increment, we might need a stored procedure or read-then-write
        // Read existing
        const { data: existing, error: fetchError } = await supabase
            .from('send_stats')
            .select('count')
            .eq('sender_id', senderId)
            .eq('date', dateStr)
            .single();

        let newCount = count;
        if (existing) {
            newCount += existing.count;
        }

        const { error } = await supabase.from('send_stats').upsert({
            sender_id: senderId,
            date: dateStr,
            count: newCount
        }, { onConflict: 'sender_id,date' });

        if (error) console.error("Supabase recordSend error:", error);
    } catch (e) {
        console.error("Supabase recordSend exception:", e);
    }
};

// --- Get stats in structured format for frontend ---
const getStructuredStats = async (sendersList = []) => {
    try {
        const { data: stats, error } = await supabase.from('send_stats').select('*');
        if (error) {
            console.error("Supabase getStructuredStats error:", error);
            return { daily: {}, monthly: {}, senders: [] };
        }

        const daily = {};
        const monthly = {};
        
        // Map senders from the provided list
        // Frontend expects: { id: "1", email: "..." }
        const senders = sendersList.map(s => ({
            id: String(s.id),
            email: s.email
        }));

        stats.forEach(row => {
            const senderId = row.sender_id;
            const dateStr = row.date; // "YYYY-MM-DD"
            const count = row.count;
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

        return { daily, monthly, senders };
    } catch (e) {
        console.error("Supabase getStructuredStats exception:", e);
        return { daily: {}, monthly: {}, senders: [] };
    }
};

module.exports = { recordSend, getStructuredStats };
