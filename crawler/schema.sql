-- The catalogue of the upstream source, mirrored so search can be answered
-- locally. Only what a suggestion row needs: everything else stays upstream.
create table if not exists titles (
  id      integer primary key,
  name    text    not null,
  year    integer,
  type    integer,
  slug    text,
  kp      text,             -- filled later, from /info; null = not asked yet
  rank    integer,          -- position in the upstream priority order
  seen    integer not null  -- unix seconds, last time the catalogue confirmed it
);
create index if not exists titles_kp_pending on titles (rank) where kp is null;
create index if not exists titles_name on titles (name);

-- Cursors and counters. One row per key so a run can be resumed after any
-- interruption, which matters when the machine that started it is asleep.
create table if not exists meta (key text primary key, value text);
