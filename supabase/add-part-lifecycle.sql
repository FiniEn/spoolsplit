-- Parts are pre-paid by the buyer and split by print time between "installed" and "replaced".
-- Safe to run more than once. Run once in the Supabase SQL Editor (after add-receipts.sql).

alter table parts add column if not exists installed_at date;
alter table parts add column if not exists retired_at date;
alter table parts drop constraint if exists parts_lifecycle_check;
alter table parts add constraint parts_lifecycle_check
  check (retired_at is null or (installed_at is not null and retired_at >= installed_at));

-- Parts already on the default (print-time) split count as installed on their purchase date
update parts set installed_at = purchased_at where split_mode = 'default' and installed_at is null;

notify pgrst, 'reload schema';
