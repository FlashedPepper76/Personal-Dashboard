// /api/todos
// POST   { text, due_label? }       -> create a manual todo
// PATCH  { id, completed }          -> toggle complete
// DELETE ?id=...                    -> dismiss/remove a todo
const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  if (req.method === 'POST') {
    const text = req.body && req.body.text && String(req.body.text).trim();
    if (!text) {
      res.status(400).json({ error: 'Missing text' });
      return;
    }
    const row = {
      text,
      due_label: req.body.due_label || null,
      source_type: 'manual',
      completed: false
    };
    const { data, error } = await supabase.from('todos').insert(row).select().single();
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
    res.status(200).json(data);
    return;
  }

  if (req.method === 'PATCH') {
    const { id, completed } = req.body || {};
    if (!id) {
      res.status(400).json({ error: 'Missing id' });
      return;
    }
    const { data, error } = await supabase
      .from('todos')
      .update({ completed: !!completed, completed_at: completed ? new Date().toISOString() : null })
      .eq('id', id)
      .select()
      .single();
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
    res.status(200).json(data);
    return;
  }

  if (req.method === 'DELETE') {
    const id = req.query.id;
    if (!id) {
      res.status(400).json({ error: 'Missing id' });
      return;
    }
    const { error } = await supabase.from('todos').delete().eq('id', id);
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
    res.status(200).json({ deleted: true });
    return;
  }

  res.status(405).json({ error: 'Use POST, PATCH, or DELETE' });
};
