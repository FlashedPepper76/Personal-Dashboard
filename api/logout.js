// POST /api/logout
// Clears the session cookie. Public (no auth required to call this — locking
// yourself out further isn't a meaningful attack, and it lets the "Lock
// dashboard" button work even if the session already expired).
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST' });
    return;
  }
  res.setHeader('Set-Cookie', 'dashboard_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');
  res.status(200).json({ ok: true });
};
