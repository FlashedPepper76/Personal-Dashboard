// GET /api/dashboard-data
// Returns the latest synced Gmail + Drive rows (plus connection status) as
// JSON for the frontend to render. Uses the service role key server-side so
// the browser never needs direct Supabase credentials.
//
// Also returns `digest`: a short AI morning-briefing sentence, generated
// from the same data already fetched below and cached one-per-calendar-day
// in daily_digest. Folded in here (rather than its own endpoint) to stay
// under Vercel's per-deployment serverless function cap.
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenAI } = require('@google/genai');

function todayDateString() {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const parts = fmt.formatToParts(new Date());
  const map = {};
  parts.forEach((p) => { map[p.type] = p.value; });
  return `${map.year}-${map.month}-${map.day}`;
}

async function getOrCreateDigest(supabase, { emails, calendarEvents, todos }) {
  const today = todayDateString();

  const { data: existing } = await supabase
    .from('daily_digest')
    .select('digest_text')
    .eq('digest_date', today)
    .maybeSingle();
  if (existing) return existing.digest_text;

  if (!process.env.GEMINI_API_KEY) return null; // degrade silently — digest is a bonus, not core data

  const prompt = `Write a short morning briefing for Carter to read at the top of his personal dashboard. 2-3 sentences, warm but concise, plain prose — no markdown, no bullet points, no headers. Mention anything genuinely noteworthy below (an urgent-looking email, a meeting today, a to-do that sounds time-sensitive), but don't pad it out if there isn't much going on — "Looks like a quiet day" is a perfectly fine thing to say.

TODAY'S DATE: ${today}

RECENT EMAILS:
${(emails || []).slice(0, 10).map((e) => `- ${e.is_unread ? '[unread] ' : ''}${e.from_name || e.from_email}: ${e.subject || '(no subject)'} — ${e.snippet || ''}`).join('\n') || '(none synced)'}

UPCOMING CALENDAR EVENTS:
${(calendarEvents || []).map((e) => `- ${e.title || '(untitled)'} (${e.calendar_name || 'calendar'}) at ${e.start_time}${e.location ? ' — ' + e.location : ''}`).join('\n') || '(none synced)'}

OPEN TO-DOS:
${(todos || []).filter((t) => !t.completed).map((t) => `- ${t.text}${t.due_label ? ' (due ' + t.due_label + ')' : ''}`).join('\n') || '(none open)'}`;

  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const aiResponse = await ai.models.generateContent({ model: 'gemini-2.5-flash', contents: prompt });
    const digestText = (aiResponse.text || '').trim();
    if (!digestText) return null;

    const { data: inserted, error: insertErr } = await supabase
      .from('daily_digest')
      .insert({ digest_date: today, digest_text: digestText })
      .select('digest_text')
      .single();
    if (!insertErr) return inserted.digest_text;

    // Unique violation = a concurrent request already inserted today's row.
    const { data: raceWinner } = await supabase
      .from('daily_digest')
      .select('digest_text')
      .eq('digest_date', today)
      .maybeSingle();
    return raceWinner ? raceWinner.digest_text : digestText;
  } catch (err) {
    console.error('[dashboard-data] digest generation failed:', err.message);
    return null; // never let a digest failure break the rest of the dashboard
  }
}

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

  const digest = await getOrCreateDigest(supabase, { emails, calendarEvents, todos });

  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    googleConnected: !!tokenRow,
    emails: emails || [],
    driveFiles: driveFiles || [],
    todos: todos || [],
    calendarEvents: calendarEvents || [],
    unseenComments: unseenComments || [],
    digest: digest || null
  });
};
