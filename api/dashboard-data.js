// GET /api/dashboard-data
// Returns the latest synced Gmail + Drive rows (plus connection status) as
// JSON for the frontend to render. Uses the service role key server-side so
// the browser never needs direct Supabase credentials.
const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const [{ data: tokenRow }, { data: emails, error: emailErr }, { data: driveFiles, error: driveErr }, { data: todos, error: todoErr }, { data: calendarEvents, error: calErr }, { data: unseenComments, error: commentErr }] = await Promise.all([
    supabase.from('integration_tokens').select('provider, updated_at').eq('provider', 'google').maybeSingle(),
    supabase.from('emails').select('*').order('received_at', { ascending: false }).limit(10),
    supabase.from('drive_files').select('*').order('modified_time', { ascending: false }).limit(10),
    supabase.from('todos').select('*').order('completed', { ascending: true }).order('created_at', { ascending: false }).limit(50),
    supabase.from('calendar_events').select('*').order('start_time', { ascending: true }).limit(8),
    supabase.from('drive_comments').select('file_id, comment_id, author_name, content, created_time').eq('seen', false).order('created_time', { ascending: false })
  ]);

  if (emailErr || driveErr || todoErr || calErr || commentErr) {
    res.status(500).json({ error: (emailErr || driveErr || todoErr || calErr || commentErr).message });
    return;
  }

  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    googleConnected: !!tokenRow,
    emails: emails || [],
    driveFiles: driveFiles || [],
    todos: todos || [],
    calendarEvents: calendarEvents || [],
    unseenComments: unseenComments || []
  });
};
