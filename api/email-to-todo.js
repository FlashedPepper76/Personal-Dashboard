// POST /api/email-to-todo   { gmailId: "..." }
// Fetches one Gmail message in full, asks Gemini to condense it into a single
// short to-do line, and inserts it into the todos table tagged
// source_type='email' / source_ref=<gmailId> — so it can be linked back to
// the original message later (see renderTodos in index.html).
// Used by the "→ To-do" button on an inbox row and inside the email modal.
const { google } = require('googleapis');
const { GoogleGenAI } = require('@google/genai');
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
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST' });
    return;
  }

  const gmailId = req.body && req.body.gmailId;
  if (!gmailId) {
    res.status(400).json({ error: 'Missing gmailId' });
    return;
  }
  if (!process.env.GEMINI_API_KEY) {
    res.status(500).json({ error: 'GEMINI_API_KEY is not set in Vercel env vars.' });
    return;
  }

  try {
    const { supabase, oauth2Client } = await getAuthorizedClient();
    if (!oauth2Client) {
      res.status(400).json({ error: 'Google not connected.' });
      return;
    }

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const full = await gmail.users.messages.get({ userId: 'me', id: gmailId, format: 'full' });
    const headers = full.data.payload?.headers;
    const from = getHeader(headers, 'From');
    const subject = getHeader(headers, 'Subject');
    const body = (extractPlainText(full.data.payload) || full.data.snippet || '').slice(0, 4000);

    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const prompt = `Condense this email into ONE short to-do line for Carter's task list — the action he should take, or if nothing's actionable, the one-line gist he'd want to remember. Under 10 words. No trailing period. No quotes.

From: ${from || 'unknown'}
Subject: ${subject || '(no subject)'}
Body:
${body}

Also infer a due_label if a deadline or date is implied (e.g. "Thu", "this week"), otherwise null.

Respond with ONLY JSON, no prose, no markdown fences:
{"text": "short todo text", "due_label": "Thu" or null}`;

    let aiResponse;
    try {
      aiResponse = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
        config: { responseMimeType: 'application/json' }
      });
    } catch (aiErr) {
      console.error('[email-to-todo] Gemini call failed:', aiErr.status, aiErr.message);
      res.status(500).json({ error: `Gemini call failed: ${aiErr.message}` });
      return;
    }

    const rawText = aiResponse.text || '';
    let parsed;
    try {
      parsed = JSON.parse(rawText.trim().replace(/^```json\s*|```$/g, ''));
    } catch (err) {
      console.error('[email-to-todo] Could not parse Gemini response:', rawText);
      res.status(500).json({ error: `Could not parse Gemini's response: ${err.message}`, raw: rawText });
      return;
    }

    const text = String(parsed.text || subject || 'Follow up on email').trim();

    const { data: todoRow, error: insertErr } = await supabase
      .from('todos')
      .insert({
        text,
        due_label: parsed.due_label || null,
        source_type: 'email',
        source_ref: gmailId,
        completed: false
      })
      .select()
      .single();
    if (insertErr) {
      console.error('[email-to-todo] Supabase insert failed:', insertErr.message);
      throw insertErr;
    }

    res.status(200).json({ todo: todoRow });
  } catch (err) {
    console.error('[email-to-todo] failed:', err.message);
    res.status(500).json({ error: err.message });
  }
};
