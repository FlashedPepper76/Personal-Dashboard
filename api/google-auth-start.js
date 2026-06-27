// GET /api/google-auth-start
// Redirects to Google's consent screen asking for read-only Gmail + Drive access.
// (redeploy trigger — picks up latest GOOGLE_CLIENT_ID/SECRET from Vercel env vars)
module.exports = async (req, res) => {
  // Fail loudly here instead of building a broken auth URL — a missing/blank
  // env var silently becomes "client_id=undefined" in the redirect to Google,
  // which Google reports back as the very unhelpful "Error 401: invalid_client".
  const missing = ["GOOGLE_CLIENT_ID", "GOOGLE_REDIRECT_URI"].filter(
    (key) => !process.env[key]
  );
  if (missing.length) {
    res.status(500).send(
      `Server is missing env var(s): ${missing.join(", ")}. ` +
      `Set them in Vercel → Project → Settings → Environment Variables (Production), then redeploy.`
    );
    return;
  }

  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: process.env.GOOGLE_REDIRECT_URI,
    response_type: "code",
    access_type: "offline",   // required to get a refresh_token back
    prompt: "consent",        // forces refresh_token on every auth, not just the first
    scope: [
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/calendar.readonly"
    ].join(" ")
  });

  const rawClientId = process.env.GOOGLE_CLIENT_ID;
  const hasStrayChars = /^\s|\s$|["']/.test(rawClientId);
  console.log(
    `google-auth-start: redirect_uri="${process.env.GOOGLE_REDIRECT_URI}" ` +
    `client_id="${rawClientId}" length=${rawClientId.length} ` +
    `hasStrayWhitespaceOrQuotes=${hasStrayChars}`
  );

  res.writeHead(302, {
    Location: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
    "Cache-Control": "no-store"
  });
  res.end();
};
