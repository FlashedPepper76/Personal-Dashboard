// POST /api/auth   { action: 'login', password: '...' }  or  { action: 'logout' }
// Merged login+logout into one function (rather than two) to stay under
// Vercel's per-deployment serverless function cap.
//
// login: checks the submitted password against DASHBOARD_PASSWORD and, on
// success, issues a signed session cookie — no session table, just an HMAC
// over an expiry timestamp, verified the same way in middleware.js.
// logout: clears the cookie. Doesn't require an existing valid session
// (harmless either way, and lets "Lock dashboard" work even if the
// session already expired).
const crypto = require('crypto');

const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function sign(expiry, secret) {
  return crypto.createHmac('sha256', secret).update(String(expiry)).digest('hex');
}

function handleLogin(req, res) {
  if (!process.env.DASHBOARD_PASSWORD || !process.env.SESSION_SECRET) {
    res.status(500).json({ error: 'DASHBOARD_PASSWORD / SESSION_SECRET not set in Vercel env vars.' });
    return;
  }

  const submittedRaw = (req.body && req.body.password) || '';
  const submitted = Buffer.from(String(submittedRaw));
  const expected = Buffer.from(process.env.DASHBOARD_PASSWORD);
  // Length check first — timingSafeEqual throws on mismatched buffer lengths
  // rather than returning false.
  const match = submitted.length === expected.length && crypto.timingSafeEqual(submitted, expected);

  if (!match) {
    res.status(401).json({ error: 'Incorrect password' });
    return;
  }

  const expiry = Date.now() + SESSION_DURATION_MS;
  const sig = sign(expiry, process.env.SESSION_SECRET);
  const token = `${expiry}.${sig}`;

  res.setHeader(
    'Set-Cookie',
    `dashboard_session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_DURATION_MS / 1000)}`
  );
  res.status(200).json({ ok: true });
}

function handleLogout(req, res) {
  res.setHeader('Set-Cookie', 'dashboard_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');
  res.status(200).json({ ok: true });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST' });
    return;
  }

  const action = req.body && req.body.action;
  if (action === 'logout') {
    handleLogout(req, res);
    return;
  }
  if (action === 'login') {
    handleLogin(req, res);
    return;
  }
  res.status(400).json({ error: "Missing or invalid 'action' (expected 'login' or 'logout')" });
};
