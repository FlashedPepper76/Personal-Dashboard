// POST /api/gmail-archive  { gmailId: "..." }
// Archives a message in the *real* Gmail account (removes the INBOX label —
// this is reversible from Gmail itself, not a delete) and removes the cached
// row from Supabase so it disappears from the dashboard immediately.
const { google } = require('googleapis');
const { getAuthorizedClient } = require('./_googleSync');

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

  try {
    const { supabase, oauth2Client } = await getAuthorizedClient();
    if (!oauth2Client) {
      res.status(400).json({ error: 'Google not connected.' });
      return;
    }

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    await gmail.users.messages.modify({
      userId: 'me',
      id: gmailId,
      requestBody: { removeLabelIds: ['INBOX'] }
    });

    const { error } = await supabase.from('emails').delete().eq('gmail_id', gmailId);
    if (error) throw error;

    res.status(200).json({ archived: true });
  } catch (err) {
    const needsReconnect = /insufficient|scope|permission/i.test(err.message);
    res.status(500).json({
      error: needsReconnect
        ? `Archiving failed (likely needs a fresh "Reconnect Google" to grant the new permission): ${err.message}`
        : err.message
    });
  }
};
