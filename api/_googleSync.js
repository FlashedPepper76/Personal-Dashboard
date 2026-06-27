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

// Collaborators whose Drive edits should always show up, even when they're
// not the most-recently-modified-by-you file.
const ALWAYS_INCLUDE_EDITORS = ['aine kim', 'benjamin zheng'];

// Upserts `rows` (keyed by idColumn) and deletes any previously-cached rows
// that are no longer part of this sync batch — so archived emails or files
// that no longer match the current filter actually disappear, not just
// never-get-added.
async function replaceSyncedRows(supabase, table, idColumn, rows) {
  if (rows.length) {
    const ids = rows.map((r) => r[idColumn]);
    const { error: delErr } = await supabase.from(table).delete().not(idColumn, 'in', `(${ids.join(',')})`);
    if (delErr) throw delErr;
    const { error: upErr } = await supabase.from(table).upsert(rows, { onConflict: idColumn });
    if (upErr) throw upErr;
  } else {
    const { error: delErr } = await supabase.from(table).delete().not('id', 'is', null);
    if (delErr) throw delErr;
  }
}

// Loads the saved Google token, builds an authorized OAuth2 client, and wires
// up auto-persisting any refreshed access token back to Supabase. Shared by
// syncGoogleData and the archive/message-detail endpoints.
async function getAuthorizedClient() {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { data: tokenRow, error: tokenErr } = await supabase
    .from('integration_tokens')
    .select('*')
    .eq('provider', 'google')
    .maybeSingle();

  if (tokenErr) throw new Error(`Loading token failed: ${tokenErr.message}`);
  if (!tokenRow) return { supabase, oauth2Client: null };

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

  oauth2Client.on('tokens', async (tokens) => {
    const update = {};
    if (tokens.access_token) update.access_token = tokens.access_token;
    if (tokens.expiry_date) update.expires_at = new Date(tokens.expiry_date).toISOString();
    if (tokens.refresh_token) update.refresh_token = tokens.refresh_token;
    if (Object.keys(update).length) {
      await supabase.from('integration_tokens').update(update).eq('provider', 'google');
    }
  });

  return { supabase, oauth2Client };
}

async function syncGoogleData() {
  const { supabase, oauth2Client } = await getAuthorizedClient();

  if (!oauth2Client) {
    return { connected: false, emails: 0, driveFiles: 0, message: 'No Google token saved yet — connect Google first.' };
  }

  let emailCount = 0;
  let driveCount = 0;
  const errors = [];

  // ---------- Gmail ----------
  // Only pull mail Gmail has flagged Important — that's the "important emails"
  // signal Gmail already computes; INBOX means archived mail naturally drops out.
  try {
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const list = await gmail.users.messages.list({
      userId: 'me',
      maxResults: 10,
      labelIds: ['INBOX', 'IMPORTANT']
    });
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

    await replaceSyncedRows(supabase, 'emails', 'gmail_id', emailRows);
    emailCount = emailRows.length;
  } catch (err) {
    errors.push(`Gmail sync failed: ${err.message}`);
  }

  // ---------- Drive ----------
  // Pull a wider window ordered by recency, then keep only files you last
  // edited yourself, OR files whose last edit came from a named collaborator
  // (Aine Kim / Benjamin Zheng) even if someone else touched it more recently.
  try {
    const drive = google.drive({ version: 'v3', auth: oauth2Client });
    const list = await drive.files.list({
      pageSize: 30,
      orderBy: 'modifiedTime desc',
      q: 'trashed = false',
      fields: 'files(id,name,modifiedTime,owners,webViewLink,lastModifyingUser)'
    });
    const candidates = list.data.files || [];

    const filtered = candidates.filter((f) => {
      const editor = f.lastModifyingUser;
      if (!editor) return false;
      if (editor.me) return true;
      const displayName = (editor.displayName || '').trim().toLowerCase();
      return ALWAYS_INCLUDE_EDITORS.includes(displayName);
    }).slice(0, 10);

    const driveRows = filtered.map((f) => ({
      file_id: f.id,
      name: f.name,
      modified_time: f.modifiedTime || null,
      owner_name: f.lastModifyingUser && f.lastModifyingUser.displayName
        ? f.lastModifyingUser.displayName
        : (f.owners && f.owners[0] ? f.owners[0].displayName : null),
      link: f.webViewLink || null,
      synced_at: new Date().toISOString()
    }));

    await replaceSyncedRows(supabase, 'drive_files', 'file_id', driveRows);
    driveCount = driveRows.length;
  } catch (err) {
    errors.push(`Drive sync failed: ${err.message}`);
  }

  return { connected: true, emails: emailCount, driveFiles: driveCount, errors };
}

module.exports = { syncGoogleData, getAuthorizedClient };
