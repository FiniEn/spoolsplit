-- Adds the "parts" table (nozzles, PTFE tubes, build plates, ...). Safe to run more than once.
-- Run once in the Supabase SQL Editor on an existing SpoolSplit database.

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

alter table parts enable row level security;
drop policy if exists "anon full access" on parts;
create policy "anon full access" on parts for all using (true) with check (true);

-- Tell Supabase's API about the new table right away.
notify pgrst, 'reload schema';
