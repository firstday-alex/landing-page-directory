const COOKIE_NAME = 'lpd_auth';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 7;

export const config = {
  matcher: '/((?!_vercel/).*)',
};

export default async function middleware(request) {
  const password = process.env.SITE_PASSWORD;
  if (!password) {
    return new Response(
      'SITE_PASSWORD is not configured on this deployment.',
      { status: 500, headers: { 'content-type': 'text/plain' } },
    );
  }

  const url = new URL(request.url);
  const expected = await sha256(password);

  if (url.pathname === '/login') {
    if (request.method === 'POST') {
      const form = await request.formData();
      const submitted = String(form.get('password') || '');
      const next = sanitizeNext(String(form.get('next') || '/'));
      if (submitted === password) {
        return new Response(null, {
          status: 303,
          headers: {
            location: next,
            'set-cookie': `${COOKIE_NAME}=${expected}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax; Secure`,
          },
        });
      }
      return htmlResponse(loginPage({ error: true, next }), 401);
    }
    return htmlResponse(loginPage({ error: false, next: sanitizeNext(url.searchParams.get('next') || '/') }));
  }

  if (cookieValue(request, COOKIE_NAME) === expected) {
    return;
  }

  const next = encodeURIComponent(url.pathname + url.search);
  return Response.redirect(new URL(`/login?next=${next}`, request.url), 302);
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function cookieValue(request, name) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq) === name) return decodeURIComponent(part.slice(eq + 1));
  }
  return null;
}

function sanitizeNext(next) {
  if (typeof next !== 'string' || !next.startsWith('/') || next.startsWith('//')) return '/';
  return next;
}

function htmlResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function loginPage({ error, next }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Landing Page Directory · Sign in</title>
<style>
  :root {
    --bg: #0f1115; --panel: #161a22; --panel-2: #1c2230; --border: #262d3b;
    --text: #e6e9ef; --muted: #8a93a6; --accent: #6ea8ff; --bad: #f47272;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #f7f8fb; --panel: #ffffff; --panel-2: #f0f3f8; --border: #e2e6ee;
      --text: #1a1f2c; --muted: #5a6275; --accent: #2e6bd6; --bad: #c33232;
    }
  }
  html, body { margin: 0; padding: 0; height: 100%; background: var(--bg); color: var(--text);
    font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  body { display: flex; align-items: center; justify-content: center; }
  form { background: var(--panel); border: 1px solid var(--border); border-radius: 8px;
    padding: 28px 28px 24px; width: 320px; max-width: calc(100vw - 32px);
    display: flex; flex-direction: column; gap: 12px; box-shadow: 0 10px 40px rgba(0,0,0,0.25); }
  h2 { margin: 0; font-size: 18px; letter-spacing: -0.01em; }
  p { margin: 0; color: var(--muted); font-size: 13px; }
  input[type="password"] { background: var(--panel-2); border: 1px solid var(--border);
    color: var(--text); border-radius: 6px; padding: 10px 12px; font: inherit; }
  input[type="password"]:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
  button { background: var(--accent); color: white; border: none; border-radius: 6px;
    padding: 10px 12px; font: inherit; cursor: pointer; }
  button:hover { filter: brightness(1.1); }
  .err { color: var(--bad); }
</style>
</head>
<body>
  <form method="post" action="/login">
    <h2>Landing Page Directory</h2>
    <p>Enter password to continue.</p>
    <input type="password" name="password" autocomplete="current-password" autofocus required />
    <input type="hidden" name="next" value="${escapeHtml(next)}" />
    <button type="submit">Enter</button>
    ${error ? '<p class="err">Incorrect password.</p>' : ''}
  </form>
</body>
</html>`;
}
