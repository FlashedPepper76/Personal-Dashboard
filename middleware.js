// Vercel Routing Middleware — runs on every request to this project before
// the static page or any /api function. Gates everything behind the signed
// `dashboard_session` cookie set by /api/auth (login action), except:
//   - /login.html and /api/auth (has to be reachable while logged out, for
//     both the login and logout actions)
//   - /api/extract-todos, but ONLY when it's the actual Vercel Cron call
//     carrying `Authorization: Bearer <CRON_SECRET>` — Vercel adds that
//     header itself when CRON_SECRET is set, so this isn't spoofable by an
//     outside caller without knowing the secret.
// Page requests without a valid session get redirected to /login.html.
// API requests without a valid session get a 401 JSON response instead
// (a redirect would just break the fetch() call on the frontend).
import crypto from 'node:crypto';

export const config = {
  runtime: 'nodejs'
};

const PUBLIC_PATHS = new Set(['/login.html', '/api/auth']);

function sign(expiry, secret) {
  return crypto.createHmac('sha256', secret).update(String(expiry)).digest('hex');
}

function hasValidSession(request) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return false;

  const cookieHeader = request.headers.get('cookie') || '';
  const match = cookieHeader.match(/(?:^|;\s*)dashboard_session=([^;]+)/);
  if (!match) return false;

  const token = decodeURIComponent(match[1]);
  const dot = token.indexOf('.');
  if (dot < 0) return false;

  const expiryStr = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expiry = Number(expiryStr);
  if (!Number.isFinite(expiry) || Date.now() > expiry) return false;

  const expected = sign(expiryStr, secret);
  if (expected.length !== sig.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}

function isCronRequest(request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return false;
  return (request.headers.get('authorization') || '') === `Bearer ${cronSecret}`;
}

export default function middleware(request) {
  const path = new URL(request.url).pathname;

  if (PUBLIC_PATHS.has(path)) return;
  if (path === '/api/extract-todos' && isCronRequest(request)) return;
  if (hasValidSession(request)) return;

  if (path.startsWith('/api/')) {
    return new Response(JSON.stringify({ error: 'Not authenticated' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  return Response.redirect(new URL('/login.html', request.url));
}
