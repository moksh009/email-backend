-- Enable Row Level Security (RLS) is recommended but we will start simple
-- Campaigns Table
CREATE TABLE IF NOT EXISTS campaigns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    subject TEXT,
    content TEXT,
    recipients JSONB DEFAULT '[]'::jsonb,
    sender_ids JSONB DEFAULT '[]'::jsonb,
    status TEXT DEFAULT 'draft',
    results JSONB DEFAULT '[]'::jsonb,
    original_message_id TEXT,
    is_follow_up BOOLEAN DEFAULT FALSE,
    follow_up_config JSONB,
    follow_up_status TEXT,
    follow_up_sent_at TIMESTAMP WITH TIME ZONE,
    follow_up_error TEXT
);

-- Send Stats Table (Incremental updates)
CREATE TABLE IF NOT EXISTS send_stats (
    sender_id TEXT NOT NULL,
    date DATE NOT NULL,
    count INTEGER DEFAULT 0,
    PRIMARY KEY (sender_id, date)
);

-- Deliverability Stats Table
CREATE TABLE IF NOT EXISTS deliverability_stats (
    sender_id TEXT PRIMARY KEY,
    total_sent INTEGER DEFAULT 0,
    total_bounces INTEGER DEFAULT 0,
    total_errors INTEGER DEFAULT 0,
    warmup_status JSONB DEFAULT '{"stage": 1, "dailyCount": 0, "lastSentDate": null}'::jsonb,
    history JSONB DEFAULT '[]'::jsonb,
    test_sends JSONB DEFAULT '[]'::jsonb
);

-- Service Configs Table (API Keys, etc)
CREATE TABLE IF NOT EXISTS service_configs (
    service_name TEXT PRIMARY KEY,
    config JSONB DEFAULT '{}'::jsonb
);
