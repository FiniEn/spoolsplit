# SpoolSplit

A small web app for two people sharing a Bambu Lab 3D printer. It tracks filament spools, logs print jobs (deducting filament from the spools used), and keeps a running balance of who owes whom.

- **Spools:** add spools by hand, or upload a receipt and Gemini fills them in, spreading tax and shipping across each spool.
- **Prints:** log a print by hand, or upload a Bambu Handy / Studio screenshot or paste a MakerWorld link. Saving a print deducts the grams from each spool, and deleting it puts them back.
- **Balance modes:**
  - *Pay Per Gram Used:* you pay the other person for their filament that you use.
  - *50/50 Spool Pool:* all spool purchases are split evenly.
- **Settle up:** record who paid whom (Venmo, Zelle, cash and so on). Payments are subtracted from the balance and from each person's "net contributed" total. The **Settle Up** button fills in the full outstanding amount.
- **CSV export** of prints and payments.

## Setup

1. Create a Supabase project and run `supabase/schema.sql` in its SQL editor. This creates the tables and the two users; edit the names in the last statement.
2. Copy `.env.example` to `.env.local` and fill in your Supabase URL, anon key, and Gemini API key.
3. Run `npm install`, then `npm run dev`.

## Security note

There is no login. The app talks to Supabase from the browser with the anon key, and the schema's row-level-security policies allow full access to anyone who has that key. The `/api/ai/*` routes are also open, so anyone with the URL can use your Gemini quota. Keep the deployment URL private, or add Supabase Auth and tighten the policies.
