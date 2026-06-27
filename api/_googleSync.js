// Shared sync logic — pulls recent Gmail messages + Drive files using the
// stored OAuth tokens and upserts them into Supabase.
// Underscore-prefixed filename so Vercel does NOT expose this as its own route;
// it's only ever called from google-auth-callback.js and sync-google.js.
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');

function parseFromHeader(raw) {
  if (!raw) return { name: null, email: null };
  const match = raw.match(/^(.*?)\s*<(.+)>$/);
  if (match) {
    return { name: match[1].replace(/"/g, '').trim() || null, email: match[2].trim() };
  }
  return { name: null, email: raw.trim() };
}

function getHeader(headers, name) {
  const h = (headers || []).find((h) => h.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : null;
}

async function syncGoogleData() {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { data: tokenRow, error: tokenErr } = await supabase
    .from('integration_tokens')
    .select('*')
    .eq('provider', 'google')
    .maybeSingle();

  if (tokenErr) throw new Error(`Loading token failed: ${tokenErr.message}`);
  if (!tokenRow) {
    return { connected: false, emails: 0, driveFiles: 0, message: 'No Google token saved yet — connect Google first.' };
  }

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  oauth2Client.setCredentials({
    access_token: tokenRow.access_token,
    refresh_token: tokenRow.refresh_token,
    expiry_date: tokenRow.expires_at ? new Date(tokenRow.expires_at).getTime() : undefined
  });

  // Persist any refreshed access token so we don't have to re-auth every time it expires.
  oauth2Client.on('tokens', async (tokens) => {
    const update = {};
    if (tokens.access_token) update.access_token = tokens.access_token;
    if (tokens.expiry_date) update.expires_at = new Date(tokens.expiry_date).toISOString();
    if (tokens.refresh_token) update.refresh_token = tokens.refresh_token;
    if (Object.keys(update).length) {
      await supabase.from('integration_tokens').update(update).eq('provider', 'google');
    }
  });

  let emailCount = 0;
  let driveCount = 0;
  const errors = [];

  // ---------- Gmail ----------
  try {
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const list = await gmail.users.messages.list({ userId: 'me', maxResults: 10, labelIds: ['INBOX'] });
    const messages = list.data.messages || [];

    const emailRows = [];
    for (const msg of messages) {
      const full = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'metadata',
        metadataHeaders: ['From', 'Subject']
      });
      const headers = full.data.payload?.headers;
      const { name, email } = parseFromHeader(getHeader(headers, 'From'));
      emailRows.push({
        gmail_id: msg.id,
        from_name: name,
        from_email: email,
        subject: getHeader(headers, 'Subject'),
        snippet: full.data.snippet || null,
        received_at: full.data.internalDate ? new Date(Number(full.data.internalDate)).toISOString() : null,
        is_unread: (full.data.labelIds || []).includes('UNREAD'),
        synced_at: new Date().toISOString()
      });
    }

    if (emailRows.length) {
      const { error } = await supabase.from('emails').upsert(emailRows, { onConflict: 'gmail_id' });
      if (error) throw error;
      emailCount = emailRows.length;
    }
  } catch (err) {
    errors.push(`Gmail sync failed: ${err.message}`);
  }

  // ---------- Drive ----------
  try {
    const drive = google.drive({ version: 'v3', auth: oauth2Client });
    const list = await drive.files.list({
      pageSize: 10,
      orderBy: 'modifiedTime desc',
      q: 'trashed = false',
      fields: 'files(id,name,modifiedTime,owners,webViewLink)'
    });
    const files = list.data.files || [];

    const driveRows = files.map((f) => ({
      file_id: f.id,
      name: f.name,
      modified_time: f.modifiedTime || null,
      owner_name: f.owners && f.owners[0] ? f.owners[0].displayName : null,
      link: f.webViewLink || null,
      synced_at: new Date().toISOString()
    }));

    if (driveRows.length) {
      const { error } = await supabase.from('drive_files').upsert(driveRows, { onConflict: 'file_id' });
      if (error) throw error;
      driveCount = driveRows.length;
    }
  } catch (err) {
    errors.push(`Drive sync failed: ${err.message}`);
  }

  return { connected: true, emails: emailCount, driveFiles: driveCount, errors };
}

module.exports = { syncGoogleData };
