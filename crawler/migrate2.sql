-- A title that answers 500 must not be able to stop the whole run, and must not
-- be retried forever either.
alter table titles add column tries integer not null default 0;
drop index if exists titles_kp_pending;
create index if not exists titles_kp_pending on titles (rank) where kp is null;

-- 2026-09-08. Phase 2 selected `where kp is null`, so a row that got its kp
-- before origin_name was added to the write was never asked again — 10,827 rows,
-- and because phase 2 runs in rating order they are the most-watched titles on
-- the site. The selector now takes anything missing either field, and this index
-- makes that selector cheap: the old ordering could not use an index at all and
-- full-scanned 81,702 rows every two minutes, which is what exhausted D1's free
-- daily row-read limit. The predicate must stay identical to the query's WHERE.
create index if not exists titles_pending
  on titles (rate_kp desc, year desc)
  where (kp is null or origin_name is null) and tries < 3 and slug <> '';
