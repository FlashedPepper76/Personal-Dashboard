// GET /api/daily-digest
// Returns a short morning-briefing sentence or two, generated from whatever's
// already synced into Supabase (emails, calendar_events, todos — no fresh
// Gmail/Calendar API calls here). Cached one row per calendar day in
// daily_digest, so opening the dashboard repeatedly in a day only costs one
// Gemini call total, not one per page load.
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenAI } = require('@google/genai');

// Use the same America/New_York "today" the rest of the app uses for
// timezone-sensitive things, rather than the server's UTC date — otherwise
// the digest could roll over to "tomorrow" several hours early/late.
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

module.exports = async (req, res) => {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const today = todayDateString();

  try {
    // ---------- Fast path: already generated today ----------
    const { data: existing, error: existingErr } = await supabase
      .from('daily_digest')
      .select('digest_text')
      .eq('digest_date', today)
      .maybeSingle();
    if (existingErr) throw existingErr;
    if (existing) {
      res.status(200).json({ digest: existing.digest_text, date: today, cached: true });
      return;
    }

    if (!process.env.GEMINI_API_KEY) {
      res.status(500).json({ error: 'GEMINI_API_KEY is not set in Vercel env vars.' });
      return;
    }

    // ---------- Gather already-synced context (no live API calls) ----------
    const [{ data: emails }, { data: events }, { data: todos }] = await Promise.all([
      supabase.from('emails').select('from_name, from_email, subject, snippet, is_unread, received_at').order('received_at', { ascending: false }).limit(10),
      supabase.from('calendar_events').select('title, start_time, end_time, location, calendar_name').order('start_time', { ascending: true }).limit(8),
      supabase.from('todos').select('text, due_label').eq('completed', false).order('created_at', { ascending: false }).limit(20)
    ]);

    const prompt = `Write a short morning briefing for Carter to read at the top of his personal dashboard. 2-3 sentences, warm but concise, plain prose — no markdown, no bullet points, no headers. Mention anything genuinely noteworthy below (an urgent-looking email, a meeting today, a to-do that sounds time-sensitive), but don't pad it out if there isn't much going on — "Looks like a quiet day" is a perfectly fine thing to say.

TODAY'S DATE: ${today}

RECENT EMAILS:
${(emails || []).map((e) => `- ${e.is_unread ? '[unread] ' : ''}${e.from_name || e.from_email}: ${e.subject || '(no subject)'} — ${e.snippet || ''}`).join('\n') || '(none synced)'}

UPCOMING CALENDAR EVENTS:
${(events || []).map((e) => `- ${e.title || '(untitled)'} (${e.calendar_name || 'calendar'}) at ${e.start_time}${e.location ? ' — ' + e.location : ''}`).join('\n') || '(none synced)'}

OPEN TO-DOS:
${(todos || []).map((t) => `- ${t.text}${t.due_label ? ' (due ' + t.due_label + ')' : ''}`).join('\n') || '(none open)'}`;

    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    let aiResponse;
    try {
      aiResponse = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt
      });
    } catch (aiErr) {
      console.error('[daily-digest] Gemini call failed:', aiErr.status, aiErr.message);
      throw new Error(`Gemini call failed: ${aiErr.message}`);
    }

    const digestText = (aiResponse.text || '').trim();
    if (!digestText) throw new Error('Gemini returned an empty digest');

    // ---------- Store it (race-safe: if another request beat us to it, use theirs) ----------
    const { data: inserted, error: insertErr } = await supabase
      .from('daily_digest')
      .insert({ digest_date: today, digest_text: digestText })
      .select('digest_text')
      .single();

    if (insertErr) {
      // Unique violation on digest_date means a concurrent request already
      // inserted today's row — just read it back instead of failing.
      const { data: raceWinner } = await supabase
        .from('daily_digest')
        .select('digest_text')
        .eq('digest_date', today)
        .maybeSingle();
      if (raceWinner) {
        res.status(200).json({ digest: raceWinner.digest_text, date: today, cached: true });
        return;
      }
      throw insertErr;
    }

    res.status(200).json({ digest: inserted.digest_text, date: today, cached: false });
  } catch (err) {
    console.error('[daily-digest] failed:', err.message);
    res.status(500).json({ error: err.message });
  }
};
