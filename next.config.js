/** @type {import('next').NextConfig} */

// Accept the Supabase variable names that the Vercel ↔ Supabase integration and the Supabase
// dashboard use, not just NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY.
// Only the public URL and the public (anon / publishable) key are exposed to the browser —
// never the service-role or secret key.
const pick = (...names) => names.map((n) => process.env[n]).find((v) => v && v.trim())?.trim() || '';

const nextConfig = {
  env: {
    NEXT_PUBLIC_SUPABASE_URL: pick('NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_URL'),
    NEXT_PUBLIC_SUPABASE_ANON_KEY: pick(
      'NEXT_PUBLIC_SUPABASE_ANON_KEY',
      'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
      'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY',
      'SUPABASE_ANON_KEY',
      'SUPABASE_PUBLISHABLE_KEY'
    ),
  },
};

module.exports = nextConfig;
