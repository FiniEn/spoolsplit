-- Adds receipts (with the original file), links spools/parts to them, and per-item split rules for parts.
-- Safe to run more than once. Run once in the Supabase SQL Editor (after add-parts.sql).

create table if not exists receipts (
  id uuid primary key default gen_random_uuid(),
  vendor text not null default '',
  purchased_at date not null default current_date,
  paid_by_user_id uuid not null references users (id),
  total numeric not null default 0 check (total >= 0),
  file_path text,            -- path inside the "receipts" storage bucket
  file_type text,
  note text,
  created_at timestamptz not null default now()
);

alter table spools add column if not exists receipt_id uuid references receipts (id) on delete set null;
alter table parts add column if not exists receipt_id uuid references receipts (id) on delete set null;

-- How a part's price is shared:
--   default  = by print time since purchase (locked at the next settle-up)
--   even     = 50/50
--   personal = only for personal_user_id (they pay all of it)
--   custom   = the buyer covers payer_share (0..1), the other person the rest
alter table parts add column if not exists split_mode text not null default 'default';
alter table parts add column if not exists personal_user_id uuid references users (id);
alter table parts add column if not exists payer_share numeric;
alter table parts drop constraint if exists parts_split_mode_check;
alter table parts add constraint parts_split_mode_check
  check (split_mode in ('default', 'even', 'personal', 'custom'));
alter table parts drop constraint if exists parts_payer_share_check;
alter table parts add constraint parts_payer_share_check
  check (payer_share is null or (payer_share >= 0 and payer_share <= 1));

alter table receipts enable row level security;
drop policy if exists "anon full access" on receipts;
create policy "anon full access" on receipts for all using (true) with check (true);

-- Private storage bucket for the original receipt images / PDFs (viewed through short-lived links).
insert into storage.buckets (id, name, public)
values ('receipts', 'receipts', false)
on conflict (id) do nothing;

drop policy if exists "spoolsplit receipts read" on storage.objects;
drop policy if exists "spoolsplit receipts upload" on storage.objects;
drop policy if exists "spoolsplit receipts delete" on storage.objects;
create policy "spoolsplit receipts read" on storage.objects
  for select using (bucket_id = 'receipts');
create policy "spoolsplit receipts upload" on storage.objects
  for insert with check (bucket_id = 'receipts');
create policy "spoolsplit receipts delete" on storage.objects
  for delete using (bucket_id = 'receipts');

notify pgrst, 'reload schema';
