// GET /api/google-auth-callback?code=...
// Exchanges the auth code for tokens and saves them server-side in Supabase.
// This is the ONLY place the refresh token gets written — the frontend never sees it.
const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  const code = req.query.code;
  if (!code) {
    res.status(400).send("Missing ?code from Google redirect.");
    return;
  }

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: process.env.GOOGLE_REDIRECT_URI,
      grant_type: "authorization_code"
    })
  });

  const tokens = await tokenRes.json();
  if (!tokens.access_token) {
    res.status(400).send(`Google token exchange failed: ${JSON.stringify(tokens)}`);
    return;
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const row = {
    provider: 'google',
    access_token: tokens.access_token,
    expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString()
  };
  // Google only sends refresh_token on first consent — don't overwrite it with null on re-auth
  if (tokens.refresh_token) row.refresh_token = tokens.refresh_token;

  const { error } = await supabase
    .from('integration_tokens')
    .upsert(row, { onConflict: 'provider' });

  if (error) {
    res.status(500).send(`Saving tokens failed: ${error.message}`);
    return;
  }

  res.setHeader('Content-Type', 'text/html');
  res.status(200).send(`<html><body style="background:#020203;color:#f0f2f6;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
    <p>Google connected — Gmail &amp; Drive access saved. You can close this tab.</p>
  </body></html>`);
};
