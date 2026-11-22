/**
 * Shared-PIN lock (WORKSPACE_PIN). Works in both the Edge middleware and Node route handlers
 * (Web Crypto only). The cookie holds an HMAC derived from the PIN, never the PIN itself, so
 * changing WORKSPACE_PIN logs everyone out.
 */

export const PIN_COOKIE = 'spoolsplit_pin';
export const PIN_COOKIE_MAX_AGE = 60 * 60 * 24 * 180; // 180 days

export function configuredPin(): string {
  return (process.env.WORKSPACE_PIN || '').trim();
}

function toBase64Url(bytes: ArrayBuffer): string {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The cookie value that proves the PIN was entered. */
export async function pinToken(pin: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(pin), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  return toBase64Url(await crypto.subtle.sign('HMAC', key, enc.encode('spoolsplit-pin-v1')));
}

/** Length-independent comparison so timing doesn't reveal how much matched. */
export function safeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/** Only allow redirects back into this app (no "//evil.com"). */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/';
  return next;
}
