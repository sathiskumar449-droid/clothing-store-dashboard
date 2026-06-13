import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
    'https://zoydhyoruiuweigxnurm.supabase.co',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpveWRoeW9ydWl1d2VpZ3hudXJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYzMjc5NzcsImV4cCI6MjA5MTkwMzk3N30.QBZt5Jkhc_YiaUN9Mu88jMYaEPrOawP_gnAmzfVb3dg'
);

export default supabase;