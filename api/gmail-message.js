// GET /api/gmail-message?id=...
// Fetches the full body of a single message on demand (not stored in
// Supabase — only pulled when you actually open one) for the click-to-expand
// email view.
const { google } = require('googleapis');
const { getAuthorizedClient } = require('./_googleSync');

function decodeBase64Url(data) {
  if (!data) return '';
  return Buffer.from(data, 'base64').toString('utf-8');
}

// MIME messages can nest parts arbitrarily (e.g. multipart/alternative inside
// multipart/mixed). Walk the tree and prefer text/plain, falling back to
// text/html if that's all there is.
function extractBody(payload) {
  if (!payload) return { text: null, html: null };

  let text = null;
  let html = null;

  function walk(part) {
    if (!part) return;
    if (part.mimeType === 'text/plain' && part.body?.data && !text) {
      text = decodeBase64Url(part.body.data);
    } else if (part.mimeType === 'text/html' && part.body?.data && !html) {
      html = decodeBase64Url(part.body.data);
    }
    (part.parts || []).forEach(walk);
  }
  walk(payload);

  return { text, html };
}

module.exports = async (req, res) => {
  const id = req.query.id;
  if (!id) {
    res.status(400).json({ error: 'Missing ?id' });
    return;
  }

  try {
    const { oauth2Client } = await getAuthorizedClient();
    if (!oauth2Client) {
      res.status(400).json({ error: 'Google not connected.' });
      return;
    }

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const full = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });

    const headers = full.data.payload?.headers || [];
    const getHeader = (name) => {
      const h = headers.find((h) => h.name.toLowerCase() === name.toLowerCase());
      return h ? h.value : null;
    };

    const { text, html } = extractBody(full.data.payload);

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      from: getHeader('From'),
      to: getHeader('To'),
      subject: getHeader('Subject'),
      date: getHeader('Date'),
      bodyText: text,
      bodyHtml: html,
      snippet: full.data.snippet || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
