// /api/drive-comments
// PATCH { file_id } -> marks all of that file's comments as seen.
// Called by the frontend the moment you click a "Recent docs" card, since
// you're about to go look at the doc anyway.
const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  if (req.method !== 'PATCH') {
    res.status(405).json({ error: 'Use PATCH' });
    return;
  }

  const fileId = req.body && req.body.file_id;
  if (!fileId) {
    res.status(400).json({ error: 'Missing file_id' });
    return;
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { error } = await supabase
    .from('drive_comments')
    .update({ seen: true })
    .eq('file_id', fileId)
    .eq('seen', false);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.status(200).json({ ok: true });
};
