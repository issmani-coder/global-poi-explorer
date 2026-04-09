import { createClient } from '@supabase/supabase-js';

// Your actual Supabase Project URL
const supabaseUrl = 'https://twrltsoodzvapiuqwrgg.supabase.co';

// Paste the fully copied Publishable key here
const supabaseKey = 'sb_publishable_eaWGQ8FpJMH_QEnDQsDT2w_GfYYuISH'; 

export const supabase = createClient(supabaseUrl, supabaseKey);