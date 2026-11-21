-- SpoolSplit database schema.
-- Run in the Supabase SQL editor on a fresh project. It matches the fields the app reads and writes
-- (see src/lib/supabase.ts). Safe to run more than once. If you already have tables, compare before running.

create extension if not exists "pgcrypto";

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  avatar_color text not null default '#10b981'
);

create table if not exists spools (
  id uuid primary key default gen_random_uuid(),
  brand text not null default 'Bambu Lab',
  material text not null,
  color_name text not null,
  color_hex text not null default '#000000',
  initial_weight_g numeric not null check (initial_weight_g > 0),
  remaining_weight_g numeric not null check (remaining_weight_g >= 0),
  purchase_price numeric not null check (purchase_price >= 0),
  -- Derived, never written by the app
  cost_per_gram numeric generated always as (purchase_price / initial_weight_g) stored,
  paid_by_user_id uuid not null references users (id),
  is_shared_split boolean not null default false,
  receipt_url text,
  is_archived boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists prints (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  printed_by_user_id uuid references users (id), -- null for shared prints
  is_shared_print boolean not null default false,
  duration_minutes integer,
  source_type text not null default 'manual' check (source_type in ('screenshot', 'url', 'manual')),
  source_url text,
  total_grams numeric not null default 0,
  total_cost numeric not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists print_spool_usages (
  id uuid primary key default gen_random_uuid(),
  print_id uuid not null references prints (id) on delete cascade,
  spool_id uuid not null references spools (id),
  grams_used numeric not null check (grams_used > 0),
  calculated_cost numeric not null default 0
);

create table if not exists settlements (
  id uuid primary key default gen_random_uuid(),
  from_user_id uuid not null references users (id),
  to_user_id uuid not null references users (id),
  amount numeric not null check (amount > 0),
  method text not null default 'Venmo',
  note text,
  settled_at timestamptz not null default now(),
  check (from_user_id <> to_user_id)
);

-- Printer parts and upkeep (nozzles, PTFE tubes, build plates, ...). Split by print time.
create table if not exists parts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text not null default 'other'
    check (category in ('nozzle', 'hotend', 'ptfe_tube', 'build_plate', 'ams_part', 'maintenance', 'other')),
  price numeric not null check (price >= 0),
  paid_by_user_id uuid not null references users (id),
  purchased_at date not null default current_date,
  note text,
  created_at timestamptz not null default now()
);

-- The app uses the public anon key from the browser and has no login yet, so these policies let
-- anyone holding the anon key read and write. Keep the app URL private, or add Supabase Auth and
-- tighten these to authenticated users.
alter table users enable row level security;
alter table spools enable row level security;
alter table prints enable row level security;
alter table print_spool_usages enable row level security;
alter table settlements enable row level security;
alter table parts enable row level security;

drop policy if exists "anon full access" on users;
create policy "anon full access" on users for all using (true) with check (true);
drop policy if exists "anon full access" on spools;
create policy "anon full access" on spools for all using (true) with check (true);
drop policy if exists "anon full access" on prints;
create policy "anon full access" on prints for all using (true) with check (true);
drop policy if exists "anon full access" on print_spool_usages;
create policy "anon full access" on print_spool_usages for all using (true) with check (true);
drop policy if exists "anon full access" on settlements;
create policy "anon full access" on settlements for all using (true) with check (true);
drop policy if exists "anon full access" on parts;
create policy "anon full access" on parts for all using (true) with check (true);

-- Seed the two people (the app expects exactly two users).
insert into users (name, avatar_color)
select * from (values ('Fini', '#10b981'), ('Mike', '#6366f1')) as v(name, avatar_color)
where not exists (select 1 from users);
