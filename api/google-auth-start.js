// GET /api/google-auth-start
// Redirects to Google's consent screen asking for read-only Gmail + Drive access.
module.exports = async (req, res) => {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: process.env.GOOGLE_REDIRECT_URI,
    response_type: "code",
    access_type: "offline",   // required to get a refresh_token back
    prompt: "consent",        // forces refresh_token on every auth, not just the first
    scope: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/drive.metadata.readonly"
    ].join(" ")
  });

  res.writeHead(302, {
    Location: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
  });
  res.end();
};
