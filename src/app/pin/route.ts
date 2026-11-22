import { configuredPin, safeNext } from '@/lib/pin';

/**
 * The PIN screen. Plain HTML (no app JavaScript) so nothing sensitive is sent before unlocking.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const next = safeNext(url.searchParams.get('next'));
  const error = url.searchParams.get('error');
  const message = !configuredPin()
    ? 'No PIN is configured on the server. Set WORKSPACE_PIN in Vercel (Settings → Environment Variables) and redeploy.'
    : error === 'wrong'
      ? 'Wrong PIN — try again.'
      : error === 'wait'
        ? 'Too many wrong tries. Wait 15 minutes and try again.'
        : '';

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#020617">
<link rel="icon" href="/icon.svg">
<link rel="manifest" href="/manifest.json">
<title>SpoolSplit — Locked</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px;
         background: #020617; color: #f8fafc; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
  .card { width: 100%; max-width: 340px; background: #0f172a; border: 1px solid #1e293b; border-radius: 16px; padding: 24px; }
  .logo { width: 44px; height: 44px; border-radius: 12px; display: grid; place-items: center;
          background: rgba(16,185,129,.1); border: 1px solid rgba(16,185,129,.25); margin-bottom: 14px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  p { font-size: 13px; color: #94a3b8; margin: 0 0 16px; }
  input { width: 100%; font-size: 22px; letter-spacing: .3em; text-align: center; padding: 12px; border-radius: 10px;
          border: 1px solid #334155; background: #020617; color: #f8fafc; }
  input:focus { outline: 2px solid #10b981; border-color: transparent; }
  button { width: 100%; margin-top: 12px; padding: 12px; border: 0; border-radius: 10px; font-size: 15px; font-weight: 600;
           background: #059669; color: #fff; cursor: pointer; }
  button:hover { background: #10b981; }
  .err { color: #fda4af; background: rgba(244,63,94,.1); border: 1px solid rgba(244,63,94,.3); border-radius: 8px;
         padding: 8px 10px; font-size: 13px; margin-bottom: 12px; }
</style>
</head>
<body>
  <form class="card" method="post" action="/api/pin">
    <div class="logo"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg></div>
    <h1>SpoolSplit</h1>
    <p>Enter the PIN to open Fini &amp; Mike's tracker.</p>
    ${message ? `<div class="err" role="alert">${escapeHtml(message)}</div>` : ''}
    <input name="pin" type="password" inputmode="numeric" autocomplete="current-password" autofocus required aria-label="PIN">
    <input type="hidden" name="next" value="${escapeHtml(next)}">
    <button type="submit">Unlock</button>
  </form>
</body>
</html>`;
  return new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
