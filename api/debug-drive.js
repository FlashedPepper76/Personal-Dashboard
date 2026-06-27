// TEMP DEBUG — GET /api/debug-drive
// Read-only: dumps the raw lastModifyingUser field Drive returns, so we can
// see why the self/collaborator filter is letting unrelated files through.
// Safe to delete once the real filter is fixed.
const { google } = require('googleapis');
const { getAuthorizedClient } = require('./_googleSync');

module.exports = async (req, res) => {
  try {
    const { oauth2Client } = await getAuthorizedClient();
    if (!oauth2Client) {
      res.status(400).json({ error: 'Google not connected.' });
      return;
    }
    const drive = google.drive({ version: 'v3', auth: oauth2Client });
    const list = await drive.files.list({
      pageSize: 15,
      orderBy: 'modifiedTime desc',
      q: 'trashed = false',
      fields: 'files(id,name,mimeType,modifiedTime,owners(displayName,emailAddress),lastModifyingUser(displayName,emailAddress,me,permissionId))'
    });
    res.status(200).json(list.data.files || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
