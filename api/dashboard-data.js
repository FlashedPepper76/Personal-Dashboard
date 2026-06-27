// GET /api/dashboard-data
// Returns the latest synced Gmail + Drive rows (plus connection status) as
// JSON for the frontend to render. Uses the service role key server-side so
// the browser never needs direct Supabase credentials.
//
// Also returns `digest` (cached AI morning briefing), `weeklyStats` (counts
// for the "This week" card), and `weather` (current NWS conditions) — all
// folded in here, and push-subscription management folded in as POST/DELETE
// on this same route below, rather than separate endpoints, to stay under
// Vercel's per-deployment serverless function cap (Hobby plan: 12).
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

// Monday-start week, computed in plain UTC for simplicity. This is a casual
// "what have I gotten done" widget, not a billing boundary — being off by a
// few hours right at the Sun-night/Mon-morning transition doesn't matter.
function weekStartISO() {
  const now = new Date();
  const daysSinceMonday = (now.getUTCDay() + 6) % 7; // getUTCDay(): 0=Sun
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() - daysSinceMonday);
  monday.setUTCHours(0, 0, 0, 0);
  return monday.toISOString();
}

async function getWeeklyStats(supabase) {
  const weekStart = weekStartISO();
  try {
    const [completed, archived, aiSuggested] = await Promise.all([
      supabase.from('todos').select('id', { count: 'exact', head: true }).gte('completed_at', weekStart),
      supabase.from('activity_log').select('id', { count: 'exact', head: true }).eq('event_type', 'email_archived').gte('created_at', weekStart),
      supabase.from('todos').select('id', { count: 'exact', head: true }).eq('source_type', 'auto').gte('created_at', weekStart)
    ]);
    return {
      completed: completed.count || 0,
      archived: archived.count || 0,
      aiSuggested: aiSuggested.count || 0
    };
  } catch (err) {
    console.error('[dashboard-data] weekly stats failed:', err.message);
    return null;
  }
}

// National Weather Service API — no key required, US-only (fine here).
// Defaults to Lexington, SC; override with WEATHER_LAT / WEATHER_LON env vars.
async function getWeather() {
  const lat = process.env.WEATHER_LAT || '33.9962';
  const lon = process.env.WEATHER_LON || '-81.2356';
  const headers = { 'User-Agent': 'command-deck-personal-dashboard (no contact on file)' };
  try {
    const pointResp = await fetch(`https://api.weather.gov/points/${lat},${lon}`, { headers });
    if (!pointResp.ok) throw new Error(`points lookup failed: ${pointResp.status}`);
    const pointData = await pointResp.json();
    const forecastUrl = pointData.properties && pointData.properties.forecast;
    if (!forecastUrl) throw new Error('no forecast URL in points response');

    const forecastResp = await fetch(forecastUrl, { headers });
    if (!forecastResp.ok) throw new Error(`forecast fetch failed: ${forecastResp.status}`);
    const forecastData = await forecastResp.json();
    const period = forecastData.properties && forecastData.properties.periods && forecastData.properties.periods[0];
    if (!period) return null;

    return {
      label: period.name,
      tempF: period.temperature,
      shortForecast: period.shortForecast,
      windSpeed: period.windSpeed,
      icon: period.icon || null
    };
  } catch (err) {
    console.error('[dashboard-data] weather fetch failed:', err.message);
    return null; // degrade silently, same pattern as the digest
  }
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

  // ---------- Push subscription management ----------
  // POST { action: 'subscribe-push', subscription } — called once the
  // browser grants Notification permission and registers the service worker.
  if (req.method === 'POST') {
    const action = req.body && req.body.action;
    if (action !== 'subscribe-push') {
      res.status(400).json({ error: "Unknown action (expected 'subscribe-push')" });
      return;
    }
    const sub = req.body.subscription;
    if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
      res.status(400).json({ error: 'Missing or malformed subscription' });
      return;
    }
    const { error } = await supabase.from('push_subscriptions').upsert(
      { endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth },
      { onConflict: 'endpoint' }
    );
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
    res.status(200).json({ ok: true });
    return;
  }

  // DELETE ?endpoint=... — called if you ever turn alerts back off.
  if (req.method === 'DELETE') {
    const endpoint = req.query.endpoint;
    if (!endpoint) {
      res.status(400).json({ error: 'Missing endpoint' });
      return;
    }
    const { error } = await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint);
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
    res.status(200).json({ ok: true });
    return;
  }

  // ---------- GET: the actual dashboard read ----------
  const [{ data: tokenRow }, { data: emails, error: emailErr }, { data: driveFiles, error: driveErr }, { data: todos, error: todoErr }, { data: calendarEvents, error: calErr }, { data: unseenComments, error: commentErr }, weeklyStats, weather] = await Promise.all([
    supabase.from('integration_tokens').select('provider, updated_at').eq('provider', 'google').maybeSingle(),
    supabase.from('emails').select('*').order('received_at', { ascending: false }).limit(10),
    supabase.from('drive_files').select('*').order('modified_time', { ascending: false }).limit(10),
    supabase.from('todos').select('*').order('completed', { ascending: true }).order('created_at', { ascending: false }).limit(50),
    supabase.from('calendar_events').select('*').order('start_time', { ascending: true }).limit(8),
    supabase.from('drive_comments').select('file_id, comment_id, author_name, content, created_time').eq('seen', false).order('created_time', { ascending: false }),
    getWeeklyStats(supabase),
    getWeather()
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
    digest: digest || null,
    weeklyStats: weeklyStats || null,
    weather: weather || null
  });
};
