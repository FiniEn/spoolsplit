import { NextRequest, NextResponse } from 'next/server';
import { PIN_COOKIE, configuredPin, pinToken, safeEqual } from '@/lib/pin';

/**
 * Everything (pages, the app's JavaScript — which contains the Supabase key — and the AI routes)
 * requires the WORKSPACE_PIN cookie. Only the PIN screen and the PWA icon/manifest are public.
 */
const PUBLIC_PATHS = new Set(['/pin', '/api/pin', '/manifest.json', '/icon.svg', '/favicon.ico']);

export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next();

  const pin = configuredPin();
  const cookie = req.cookies.get(PIN_COOKIE)?.value || '';
  if (pin && cookie && safeEqual(cookie, await pinToken(pin))) return NextResponse.next();

  // Not unlocked (or no PIN configured: fail closed)
  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Locked: enter the PIN first (reload the page).' }, { status: 401 });
  }
  const isPage = req.method === 'GET' && !pathname.startsWith('/_next/');
  if (!isPage) return new NextResponse('Locked', { status: 401 });
  const url = req.nextUrl.clone();
  url.pathname = '/pin';
  url.search = `?next=${encodeURIComponent(pathname + search)}`;
  return NextResponse.redirect(url);
}

export const config = {
  // Run on every request, including /_next/static (so the app's code is locked too)
  matcher: '/:path*',
};
