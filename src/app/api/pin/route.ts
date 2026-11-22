import { NextResponse } from 'next/server';
import { PIN_COOKIE, PIN_COOKIE_MAX_AGE, configuredPin, pinToken, safeEqual, safeNext } from '@/lib/pin';

// Best-effort brute-force brake: per-IP failure counts in this server instance's memory.
const FAIL_LIMIT = 5;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const failures = new Map<string, { count: number; since: number }>();

function clientIp(request: Request) {
  return (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
}

/** Unlock: checks the PIN, sets the cookie and sends the browser back into the app. */
export async function POST(request: Request) {
  const form = await request.formData().catch(() => null);
  const entered = String(form?.get('pin') ?? '').trim();
  const next = safeNext(String(form?.get('next') ?? '/'));
  const back = (error: string) =>
    NextResponse.redirect(new URL(`/pin?error=${error}&next=${encodeURIComponent(next)}`, request.url), 303);

  const pin = configuredPin();
  if (!pin) return back('config');

  const ip = clientIp(request);
  const now = Date.now();
  const rec = failures.get(ip);
  if (rec && now - rec.since < FAIL_WINDOW_MS && rec.count >= FAIL_LIMIT) return back('wait');

  if (!entered || !safeEqual(entered, pin)) {
    const fresh = !rec || now - rec.since >= FAIL_WINDOW_MS;
    failures.set(ip, { count: fresh ? 1 : rec!.count + 1, since: fresh ? now : rec!.since });
    await new Promise((r) => setTimeout(r, 1000)); // slow down guessing
    return back('wrong');
  }

  failures.delete(ip);
  const res = NextResponse.redirect(new URL(next, request.url), 303);
  res.cookies.set(PIN_COOKIE, await pinToken(pin), {
    httpOnly: true,
    sameSite: 'lax',
    secure: new URL(request.url).protocol === 'https:',
    path: '/',
    maxAge: PIN_COOKIE_MAX_AGE,
  });
  return res;
}

/** Lock: clears the cookie on this device. */
export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(PIN_COOKIE, '', { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 0 });
  return res;
}
