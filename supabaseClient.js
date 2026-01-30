
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.warn('Supabase credentials missing. Ensure SUPABASE_URL and SUPABASE_ANON_KEY are set in .env');
}

const supabase = createClient(supabaseUrl, supabaseKey);

module.exports = supabase;
