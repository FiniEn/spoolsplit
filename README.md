# SpoolSplit

A small web app for two people sharing a Bambu Lab 3D printer. It tracks what each person spent on filament and used in prints, and keeps a running balance of who owes whom.

- **Purchases:** add spools and parts by hand, or upload a receipt and Gemini fills them in. Tax and shipping are spread across every item, and parts (nozzles, hotends, PTFE tubes, build plates, AMS parts, maintenance) go in their own list.
- **Prints:** log a print by hand, or upload a Bambu Handy / Studio screenshot or paste a MakerWorld link, and the name, print time and grams fill in. Each print's cost is worked out from the grams used and the spool's price per gram.
- **Parts are pre-paid and split by use:** printer parts (nozzles, build plates, hotends, PTFE tubes, AMS parts) are paid for by whoever buys them. When you log a print, **Parts used** dropdowns record which ones it used, starting with the parts from your last print. When a part is marked **Replaced**, its price is split by the print time of the prints that used it (shared prints count half each; 50/50 if it was never used). Until then the Wallet shows an estimate, and it isn't part of the settle-up amount. Parts without a receipt, like the ones that came with the printer, can be added with **+ Add part**. "Other item" purchases default to personal for the buyer.
- **Wallet model:** whoever buys a spool or part pays from their own wallet. You owe the other person only for what you use of *their* purchases. Using your own costs nothing, and shared prints split half each. Everything nets out to **at most one payment** between you.
- **Settle up:** the Wallet tab shows the one payment that settles everything ("Fini pays Mike $8.67"). Recording it closes the period, which also locks the print-time split of any parts bought before it. You can still record partial payments.
- **Receipts:** every saved purchase keeps its full item list and the original image or PDF ("View original"), under **Purchases → Receipts**. Spools are always pay-per-use. Every other item can be split **by print time** (the default for printer parts), **50/50**, **only for Fini / Mike** (personal), or a **custom %**, when you add it or any time later. A manual split is charged right away instead of waiting for the part to be replaced.
- **History:** every purchase, print, part and payment is listed with what it changed and the balance after it, grouped by settle-up.
- **AI model:** receipts and screenshots are read by Gemini (`gemini-3.8-flash`, or `GEMINI_MODEL`). If it answers "high demand", the app retries and then falls back to `gemini-3.5-flash` and `gemini-3.5-flash-lite` (change the list with `GEMINI_FALLBACK_MODELS`).
- **CSV export** of the full wallet history.

## Setup

1. Create a Supabase project and run `supabase/schema.sql` in its SQL editor. Then run `supabase/add-receipts.sql`, `supabase/add-part-lifecycle.sql` and `supabase/add-print-parts.sql`, which adds receipts, per-item splits and the private `receipts` storage bucket for the files. If your database was set up before parts existed, run `supabase/add-parts.sql` first. This creates the tables and the two users; edit the names in the last statement.
2. Copy `.env.example` to `.env.local` and fill in your Supabase URL, anon key, and Gemini API key.
3. Run `npm install`, then `npm run dev`.

## Security

- **PIN lock:** the whole app is locked behind `WORKSPACE_PIN`. That covers the pages, the app's JavaScript (which contains the Supabase key) and the Gemini routes. It is checked on the server, so the app won't open without it.
- **Staying unlocked:** a correct PIN keeps that device unlocked for 180 days. The 🔒 button locks it again, and changing `WORKSPACE_PIN` locks every device.
- **Wrong PINs:** each wrong PIN takes a second to answer, and 5 wrong tries lock that IP address out for 15 minutes. Use 6 or more digits.
- **Known limit:** the database rules still allow anyone who has the Supabase anon key. The key is now only delivered after the PIN, but anyone who unlocks the app can see it. For per-person access, add Supabase Auth and tighten the policies in `supabase/schema.sql`.
