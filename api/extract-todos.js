// GET /api/extract-todos
// Run daily by Vercel Cron (see vercel.json). Also safe to call manually.
// Gathers recent important emails (full bodies) + Drive doc content (if the
// connected token has drive.readonly — gracefully skipped otherwise), asks
// Claude to extract concrete action items, and inserts new ones as 'auto'
// todos. Skips anything that duplicates an already-open todo.
const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');
const { getAuthorizedClient } = require('./_googleSync');

function getHeader(headers, name) {
  const h = (headers || []).find((h) => h.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : null;
}

function decode(data) {
  if (!data) return '';
  return Buffer.from(data, 'base64url').toString('utf-8');
}

function extractPlainText(payload) {
  let text = null;
  function walk(part) {
    if (!part) return;
    if (part.mimeType === 'text/plain' && part.body?.data && !text) text = decode(part.body.data);
    (part.parts || []).forEach(walk);
  }
  walk(payload);
  return text;
}

module.exports = async (req, res) => {
  // Optional shared-secret check — only enforced if you've set CRON_SECRET
  // in Vercel env vars yourself; harmless no-op otherwise.
  if (process.env.CRON_SECRET) {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(500).json({ error: 'ANTHROPIC_API_KEY is not set in Vercel env vars.' });
    return;
  }

  try {
    const { supabase, oauth2Client } = await getAuthorizedClient();
    if (!oauth2Client) {
      res.status(400).json({ error: 'Google not connected.' });
      return;
    }

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const drive = google.drive({ version: 'v3', auth: oauth2Client });

    // ---------- Gather email context (full bodies, not just snippets) ----------
    const list = await gmail.users.messages.list({
      userId: 'me',
      maxResults: 8,
      labelIds: ['INBOX', 'IMPORTANT']
    });
    const messages = list.data.messages || [];

    const emailContext = [];
    for (const msg of messages) {
      const full = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'full' });
      const headers = full.data.payload?.headers;
      const bodyText = extractPlainText(full.data.payload) || full.data.snippet || '';
      emailContext.push({
        gmailId: msg.id,
        from: getHeader(headers, 'From'),
        subject: getHeader(headers, 'Subject'),
        date: getHeader(headers, 'Date'),
        body: bodyText.slice(0, 3000)
      });
    }

    // ---------- Gather Drive doc content (best-effort; needs drive.readonly) ----------
    const { data: driveRows } = await supabase.from('drive_files').select('file_id, name').limit(6);
    const docContext = [];
    let driveContentAvailable = true;
    for (const row of driveRows || []) {
      try {
        const meta = await drive.files.get({ fileId: row.file_id, fields: 'mimeType' });
        if (meta.data.mimeType === 'application/vnd.google-apps.document') {
          const exported = await drive.files.export({ fileId: row.file_id, mimeType: 'text/plain' });
          docContext.push({ name: row.name, fileId: row.file_id, text: String(exported.data).slice(0, 4000) });
        }
      } catch (err) {
        if (/insufficient|scope|permission/i.test(err.message)) driveContentAvailable = false;
        // Skip this file either way — one bad file shouldn't kill the whole run.
      }
    }

    // ---------- Ask Claude to extract action items ----------
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const prompt = `You are scanning Carter's recent important emails${docContext.length ? ' and Google Docs' : ''} to suggest concrete to-do items for his personal dashboard.

EMAILS:
${emailContext.map((e, i) => `[${i}] gmailId=${e.gmailId}\nFrom: ${e.from}\nSubject: ${e.subject}\nDate: ${e.date}\nBody:\n${e.body}`).join('\n\n---\n\n')}

${docContext.length ? `DOCS:\n${docContext.map((d, i) => `[doc${i}] fileId=${d.fileId}\nName: ${d.name}\nContent:\n${d.text}`).join('\n\n---\n\n')}` : ''}

Only suggest something if there's a clear, concrete action Carter needs to take (a reply owed, a deadline, a task someone asked him to do, an unresolved item flagged in a doc). Skip newsletters, receipts, marketing, and anything purely informational. Be conservative — a short list of real action items beats a long list of guesses.

Respond with ONLY a JSON array (no prose, no markdown fences), each item shaped like:
{"text": "short actionable description", "due_label": "Thu" or "this week" or null, "source_type": "email" or "doc", "source_ref": "the gmailId or fileId it came from"}

If there's nothing actionable, respond with: []`;

    const aiResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }]
    }).catch((aiErr) => {
      console.error('[extract-todos] Anthropic call failed:', aiErr.status, aiErr.message);
      throw new Error(`Claude call failed: ${aiErr.message}`);
    });

    const rawText = aiResponse.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    let suggestions = [];
    try {
      suggestions = JSON.parse(rawText.trim().replace(/^```json\s*|```$/g, ''));
    } catch (err) {
      res.status(500).json({ error: `Could not parse Claude's response: ${err.message}`, raw: rawText });
      return;
    }

    // ---------- De-dupe against currently-open todos, then insert ----------
    const { data: openTodos } = await supabase.from('todos').select('text').eq('completed', false);
    const openTextSet = new Set((openTodos || []).map((t) => t.text.trim().toLowerCase()));

    const toInsert = suggestions
      .filter((s) => s && s.text && !openTextSet.has(String(s.text).trim().toLowerCase()))
      .map((s) => ({
        text: String(s.text).trim(),
        due_label: s.due_label || null,
        source_type: 'auto',
        source_ref: s.source_ref || null,
        completed: false
      }));

    if (toInsert.length) {
      const { error: insertErr } = await supabase.from('todos').insert(toInsert);
      if (insertErr) throw insertErr;
    }

    res.status(200).json({
      suggested: suggestions.length,
      inserted: toInsert.length,
      skippedDuplicates: suggestions.length - toInsert.length,
      driveContentAvailable
    });
  } catch (err) {
    console.error('[extract-todos] failed:', err.message);
    res.status(500).json({ error: err.message });
  }
};
