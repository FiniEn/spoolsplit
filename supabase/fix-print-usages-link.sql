-- Optional: link print_spool_usages to prints in an existing database.
-- The app works without this, but with it the database deletes a print's filament rows
-- together with the print and rejects rows that point to a print that doesn't exist.

-- 1. Remove filament rows whose print no longer exists (otherwise step 2 fails).
delete from print_spool_usages u
where not exists (select 1 from prints p where p.id = u.print_id);

-- 2. Add the link.
alter table print_spool_usages
  add constraint print_spool_usages_print_id_fkey
  foreign key (print_id) references prints (id) on delete cascade;

-- 3. Tell Supabase's API to pick up the change.
notify pgrst, 'reload schema';
