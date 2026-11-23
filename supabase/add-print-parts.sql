-- Which parts (nozzle, build plate, hotend, PTFE tube, AMS part) each print used.
-- A part's cost is split by the print time of the prints that used it, charged when it's replaced.
-- Safe to run more than once. Run once in the Supabase SQL Editor (after add-part-lifecycle.sql).

create table if not exists print_part_usages (
  id uuid primary key default gen_random_uuid(),
  print_id uuid not null references prints (id) on delete cascade,
  part_id uuid not null references parts (id) on delete cascade,
  unique (print_id, part_id)
);

alter table print_part_usages enable row level security;
drop policy if exists "anon full access" on print_part_usages;
create policy "anon full access" on print_part_usages for all using (true) with check (true);

-- Usage now comes from prints, not from an "installed" date, so a part can be replaced without one.
alter table parts drop constraint if exists parts_lifecycle_check;
alter table parts add constraint parts_lifecycle_check
  check (retired_at is null or retired_at >= purchased_at);

-- One-time reset (only touches parts not linked to any print yet, so re-running is harmless):
-- printer parts that aren't replaced go back to "spare" ...
update parts p set installed_at = null
where p.split_mode = 'default' and p.retired_at is null and p.category <> 'other'
  and not exists (select 1 from print_part_usages u where u.part_id = p.id);
-- ... and "Other items" still on the default split become personal for the buyer.
update parts p set split_mode = 'personal', personal_user_id = p.paid_by_user_id, installed_at = null
where p.split_mode = 'default' and p.category = 'other'
  and not exists (select 1 from print_part_usages u where u.part_id = p.id);

notify pgrst, 'reload schema';
