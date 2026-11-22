# SpoolSplit

A small web app for two people sharing a Bambu Lab 3D printer. It tracks what each person spent on filament and used in prints, and keeps a running balance of who owes whom.

- **Purchases:** add spools and parts by hand, or upload a receipt and Gemini fills them in. Tax and shipping are spread across every item, and parts (nozzles, hotends, PTFE tubes, build plates, AMS parts, maintenance) go in their own list.
- **Prints:** log a print by hand, or upload a Bambu Handy / Studio screenshot or paste a MakerWorld link, and the name, print time and grams fill in. Each print's cost is worked out from the grams used and the spool's price per gram.
- **Parts split by print time:** each part's price is shared in proportion to the hours each person printed since it was bought. Shared prints count half each, and the split is 50/50 until someone prints.
- **Wallet model:** whoever buys a spool or part pays from their own wallet. You owe the other person only for what you use of *their* purchases. Using your own costs nothing, and shared prints split half each. Everything nets out to **at most one payment** between you.
- **Settle up:** the Wallet tab shows the one payment that settles everything ("Fini pays Mike $8.67"). Recording it closes the period, which also locks the print-time split of any parts bought before it. You can still record partial payments.
- **Receipts:** every saved purchase keeps its full item list and the original image or PDF ("View original"), under **Purchases → Receipts**. Spools are always pay-per-use. Every other item can be split **by print time** (the default), **50/50**, **only for Fini / Mike** (personal), or a **custom %**, when you add it or any time later. A manual split is charged right away instead of waiting for print time.
- **History:** every purchase, print, part and payment is listed with what it changed and the balance after it, grouped by settle-up.
- **CSV export** of the full wallet history.

## Setup

1. Create a Supabase project and run `supabase/schema.sql` in its SQL editor. Then run `supabase/add-receipts.sql`, which adds receipts, per-item splits and the private `receipts` storage bucket for the files. If your database was set up before parts existed, run `supabase/add-parts.sql` first. This creates the tables and the two users; edit the names in the last statement.
2. Copy `.env.example` to `.env.local` and fill in your Supabase URL, anon key, and Gemini API key.
3. Run `npm install`, then `npm run dev`.

## Security note

There is no login. The app talks to Supabase from the browser with the anon key, and the schema's row-level-security policies allow full access to anyone who has that key. The `/api/ai/*` routes are also open, so anyone with the URL can use your Gemini quota. Keep the deployment URL private, or add Supabase Auth and tighten the policies.
