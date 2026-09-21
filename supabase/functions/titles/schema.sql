-- The mirrored catalogue. Built by the Cloudflare crawler, rendered into static
-- per-letter shards in Storage, and read from there by the browser.
create table if not exists titles (
  id             integer primary key,
  name           text not null,
  year           integer,
  type           integer,
  slug           text,
  initial        text,
  origin_initial text,
  shard_keys     text[],
  embed_id       integer,
  kp             text,
  rate_kp        real,
  origin_name    text,
  is_series      boolean
);

create index if not exists titles_initial on titles (initial);
create index if not exists titles_origin_initial on titles (origin_initial);

-- The shard query is an array-contains, so GIN.
create index if not exists titles_shard_keys on titles using gin (shard_keys);

-- /resolve looks a title up by slug, and until this existed that was a
-- sequential scan of all 81,702 rows — 1035ms measured — on the write half of
-- every resolve. Unique because slugs are (81,702 of 81,702 distinct), and
-- because the lookup wants exactly one row to then PATCH by primary key.
create unique index if not exists titles_slug on titles (slug);

-- Every letter a title can be reached by: the first character of each of its
-- words, across the Russian name and the original one.
--
-- Routing used to be a single `initial`, so «Пираты Карибского моря» lived only
-- in shard п. The matcher has always claimed it matches the start of any word —
-- the tests assert it — but the client loads the shard for the first letter of
-- the QUERY, so typing «карибского» fetched shard к and the row was never
-- delivered to the matcher at all. Exactly the shape of the earlier
-- English-title bug: the matcher could, the router never let it.
--
-- Costs 2.4× the row instances (111k -> 269k) and takes the busiest shard from
-- 259KB to ~450KB brotli. Filtering out words shorter than three characters
-- saves only 11% and loses real queries, so every word counts.
create or replace function shard_keys_of(p_name text, p_origin text) returns text[]
language sql immutable as $fn$
  select coalesce(array_agg(distinct letter), '{}'::text[])
  from (
    select replace(lower(left(w, 1)), 'ё', 'е') as letter
    from unnest(regexp_split_to_array(
      -- Mirrors the client's suggestFold exactly: runs of non-alphanumerics
      -- become one space, lowercase, ё folded to е.
      regexp_replace(coalesce(p_name, '') || ' ' || coalesce(p_origin, ''), '[^[:alnum:]]+', ' ', 'g'),
      ' +')) as w
    where w <> ''
  ) t
  where letter <> '';
$fn$;

alter table titles add column if not exists shard_keys text[];

-- Ingestion state is not part of the public seven-field search row.
alter table titles add column if not exists source_revision text;
-- Existing backlog keeps NULL; only discoveries after this migration receive
-- a timestamp. Do not turn the whole old catalogue into urgent fresh work.
alter table titles add column if not exists first_seen_at timestamptz;
alter table titles alter column first_seen_at set default now();
alter table titles add column if not exists last_checked_at timestamptz;
alter table titles add column if not exists next_check_at timestamptz;
alter table titles add column if not exists source_changed boolean not null default false;
create index if not exists titles_next_check on titles (next_check_at, id) where next_check_at is not null;
create table if not exists public.titles_sync_state (
  id text primary key check (id = 'lift'), last_full_at timestamptz
);
alter table public.titles_sync_state add column if not exists next_full_page integer not null default 1;
alter table public.titles_sync_state add column if not exists full_started_at timestamptz;
alter table public.titles_sync_state enable row level security;
revoke all on public.titles_sync_state from anon, authenticated;

-- When anything a shard carries last changed. The CDN publisher ships only rows
-- newer than the base it already published, so a republish of identical values
-- (the crawler re-sends whole rows) must leave it alone.
alter table titles add column if not exists changed_at timestamptz;
create index if not exists titles_changed_at on titles (changed_at, id) where changed_at is not null;

-- One BEFORE trigger owns everything derived, and everything that must not be
-- lost. Two of them would have needed an ordering, and Postgres orders
-- same-kind triggers alphabetically by name — a footgun to leave lying around.
create or replace function titles_before_write() returns trigger
language plpgsql as $fn$
declare
  first_alnum text;
begin
  -- Enrichment never regresses to null.
  --
  -- Two independent writers own these columns: the crawler, which publishes
  -- whole rows out of its own D1 copy, and /resolve, which writes straight here.
  -- So a title resolved by a viewer (embed_id 44097) whose D1 row still says
  -- null was reset to null the next time the crawler republished it — and phase
  -- 1 marks every row it re-reads dirty, so this needs no unusual sequence.
  -- null means "not known" for all four; a writer that knows nothing must not
  -- overwrite one that knows something.
  if tg_op = 'UPDATE' then
    new.embed_id    := coalesce(new.embed_id, old.embed_id);
    new.kp          := coalesce(nullif(new.kp, ''), old.kp, new.kp);
    new.origin_name := coalesce(nullif(new.origin_name, ''), old.origin_name, new.origin_name);
    new.is_series   := coalesce(new.is_series, old.is_series);
  end if;

  -- Both initials are still derived here rather than by whoever writes the row,
  -- because they did drift: `initial` was once the bare first character the
  -- crawler sent, so 101 titles like «Авария» – дочь мента sat in a shard named
  -- « that no viewer can ask for — the client strips leading punctuation before
  -- it picks a letter.
  first_alnum := lower(substring(regexp_replace(coalesce(new.name, ''), '[^[:alnum:]]+', '', 'g') from 1 for 1));
  new.initial := nullif(replace(first_alnum, 'ё', 'е'), '');
  first_alnum := lower(substring(regexp_replace(coalesce(new.origin_name, ''), '[^[:alnum:]]+', '', 'g') from 1 for 1));
  new.origin_initial := nullif(replace(first_alnum, 'ё', 'е'), '');
  new.shard_keys := shard_keys_of(new.name, new.origin_name);
  if tg_op = 'INSERT' then
    new.changed_at := now();
  elsif (old.name, old.year, old.slug, old.is_series, old.embed_id, old.kp,
         old.origin_name, old.shard_keys)
        is distinct from
        (new.name, new.year, new.slug, new.is_series, new.embed_id, new.kp,
         new.origin_name, new.shard_keys) then
    new.changed_at := now();
  else
    new.changed_at := old.changed_at;
  end if;
  return new;
end
$fn$;

drop trigger if exists titles_initials_trg on titles;
drop trigger if exists titles_before_write on titles;
create trigger titles_before_write
  before insert or update on titles
  for each row execute function titles_before_write();

-- The rebuild queue. /build pops letters from it, so a write rewrites only the
-- shards it actually changed. At most one row per distinct letter, so it never
-- grows.
create table if not exists shard_dirty (
  letter    text primary key,
  marked_at timestamptz not null default now()
);

-- The order letters are rebuilt in. `marked_at` moves on every change, and the
-- crawler marks forty-odd letters in one statement, so ordering by it left the
-- builder taking the same six letters in physical order every tick while the
-- busiest ones starved — shard п went two days without a rebuild while its rows
-- changed every minute. This one is set when a letter joins the queue and is
-- pushed to the back only after the letter is built.
alter table shard_dirty add column if not exists first_marked_at timestamptz;
update shard_dirty set first_marked_at = marked_at where first_marked_at is null;
alter table shard_dirty alter column first_marked_at set default now();

-- A row that left a shard — renamed, or its slug changed — so a delta built on
-- an older base knows to drop it there, not only to add it elsewhere.
create table if not exists shard_removed (
  letter     text not null,
  slug       text not null,
  removed_at timestamptz not null default now(),
  primary key (letter, slug)
);
create index if not exists shard_removed_at on shard_removed (removed_at);
alter table shard_removed enable row level security;

-- Invalidation belongs here and not in whoever writes the row.
--
-- It started life as a set computed inside the ingest handler, which meant
-- /resolve — a second writer to the same table — queued nothing at all. Rows it
-- wrote reached Postgres and no shard, so its whole purpose ("write it back and
-- the next viewer gets it for free") bought nothing: viewers read a Storage
-- snapshot, and the next one paid another request to the source for the same
-- title. A trigger cannot be forgotten by a writer that did not exist yet.
create or replace function titles_mark_shard_dirty() returns trigger
language plpgsql as $fn$
begin
  -- Every shard the row is in, and on an update every shard it was in: a rename
  -- leaves some and enters others, and both sides are stale.
  --
  -- DISTINCT is load-bearing. Proposing one key twice in a single statement
  -- makes ON CONFLICT DO UPDATE abort with "cannot affect row a second time",
  -- which fails the caller's write, not just the bookkeeping.
  insert into shard_dirty (letter, marked_at)
  select distinct letter, now() from unnest(
    coalesce(new.shard_keys, '{}'::text[]) ||
    case when tg_op = 'UPDATE' then coalesce(old.shard_keys, '{}'::text[]) else '{}'::text[] end
  ) as letter
  where letter is not null and letter <> ''
  -- Never ignore-duplicates. Moving the timestamp is what tells a build already
  -- in flight that its snapshot is stale: the builder deletes the queue entry
  -- only if the mark still matches the one it read before it started. With
  -- ignore-duplicates the second mark changed nothing and the unconditional
  -- delete then threw it away — the change sat in Postgres, in no shard, and
  -- nothing noticed until something else happened to touch that letter.
  on conflict (letter) do update set marked_at = excluded.marked_at;
  if tg_op = 'UPDATE' and old.slug is not null then
    insert into shard_removed (letter, slug, removed_at)
    select distinct letter, old.slug, now()
    from unnest(coalesce(old.shard_keys, '{}'::text[])) as letter
    where letter <> ''
      and (old.slug is distinct from new.slug
           or not (letter = any (coalesce(new.shard_keys, '{}'::text[]))))
    on conflict (letter, slug) do update set removed_at = excluded.removed_at;
  end if;
  return null;
end
$fn$;

-- Two triggers, because a WHEN clause cannot see TG_OP — it may reference only
-- OLD and NEW, and OLD does not exist on an insert.
drop trigger if exists titles_shard_dirty_ins on titles;
drop trigger if exists titles_shard_dirty_upd on titles;

create trigger titles_shard_dirty_ins
  after insert on titles
  for each row execute function titles_mark_shard_dirty();

create trigger titles_shard_dirty_upd
  after update of name, year, slug, is_series, embed_id, kp, origin_name on titles
  for each row
  -- Only what a shard actually carries, plus the keys that decide which shards
  -- carry it. A write that changes none of them invalidates nothing.
  when (
    (old.name, old.year, old.slug, old.is_series, old.embed_id, old.kp,
     old.origin_name, old.shard_keys)
    is distinct from
    (new.name, new.year, new.slug, new.is_series, new.embed_id, new.kp,
     new.origin_name, new.shard_keys)
  )
  execute function titles_mark_shard_dirty();

-- Every letter any shard is keyed by. Asking `titles` directly returns only the
-- first 1000 rows' worth — PostgREST's cap — and the builder then silently skips
-- most of the alphabet.
create or replace view shard_letters as
  select distinct unnest(shard_keys) as letter from titles;

-- Storage: a public bucket `index` holding v<N>/<codepoint-hex>.json per letter.
-- Public because the shards are the same data the site already serves, and
-- because a public object is CDN-cached while a function response never is.
--   insert into storage.buckets (id, name, public) values ('index','index',true)
--     on conflict (id) do update set public = true;
--
-- Storage ignores Cache-Control on upload — header and multipart cacheControl
-- alike — and serves every object as `no-cache`. That is not the problem it
-- looks like: the CDN then revalidates, so a rebuilt shard is visible at once.
-- The staleness that mattered was the browser's own copy, which had nothing
-- checking it for a week; the client now revalidates it with an ETag.

-- Re-derive every row after changing the trigger:
--   update titles set name = name;

-- ---------------------------------------------------------------- catalogue sync
-- The hourly sync job (scripts/sync-titles.mjs, GitHub Actions) keeps this table
-- in step with the source: newly listed titles, changed names and years, and the
-- player/Kinopoisk ids of titles not yet resolved. It writes through these two
-- functions so an unchanged row costs no write at all — a daily re-read of the
-- whole catalogue must not become 82,000 updates, dirty shards and a huge delta.

alter table titles add column if not exists fill_tries smallint not null default 0;
create index if not exists titles_pending_fill on titles (id desc)
  where (kp is null or origin_name is null) and fill_tries < 3;

create or replace function titles_upsert_catalog(p_rows jsonb)
returns table (inserted integer, updated integer)
language plpgsql security definer set search_path = public as $fn$
#variable_conflict use_column
declare
  n_inserted integer := 0;
  n_updated integer := 0;
begin
  create temporary table incoming on commit drop as
    select distinct on ((r->>'id')::integer)
           (r->>'id')::integer as id,
           btrim(r->>'name') as name,
           nullif(r->>'year', '')::integer as year,
           nullif(r->>'type', '')::integer as type,
           nullif(btrim(r->>'slug'), '') as slug,
           nullif(r->>'rate_kp', '')::real as rate_kp,
           r->>'source_revision' as source_revision
      from jsonb_array_elements(p_rows) as r
     where (r->>'id') ~ '^[0-9]{1,9}$' and coalesce(btrim(r->>'name'), '') <> '';

  -- New titles. Any conflict — the id, or a slug another title already holds —
  -- leaves the table as it is rather than failing the whole page.
  insert into titles (id, name, year, type, slug, rate_kp, source_revision)
  select id, name, year, type, slug, rate_kp, source_revision from incoming
  on conflict do nothing;
  get diagnostics n_inserted = row_count;

  -- Known titles, only where something actually differs.
  update titles t
     set name = i.name, year = i.year, type = i.type, slug = i.slug, rate_kp = i.rate_kp,
         source_revision = coalesce(i.source_revision, t.source_revision),
         source_changed = t.source_changed or (t.source_revision is not null and i.source_revision is not null
           and t.source_revision is distinct from i.source_revision),
         next_check_at = case when t.source_revision is not null and i.source_revision is not null
           and t.source_revision is distinct from i.source_revision then now() else t.next_check_at end
    from incoming i
   where t.id = i.id
     and (t.name, t.year, t.type, t.slug, t.rate_kp, t.source_revision) is distinct from (i.name, i.year, i.type, i.slug, i.rate_kp, coalesce(i.source_revision, t.source_revision))
     and not exists (select 1 from titles x where x.slug = i.slug and x.id <> i.id);
  get diagnostics n_updated = row_count;
  return query select n_inserted, n_updated;
end
$fn$;

-- What a title's own page said: its player and Kinopoisk ids and original name.
-- "" for kp and origin_name means "asked, and there is none"; a failure only
-- counts a try and schedules a slower retry after repeated failures.
create or replace function titles_fill(p_rows jsonb)
returns integer
language plpgsql security definer set search_path = public as $fn$
declare
  n integer := 0;
  m integer := 0;
begin
  update titles t
     set kp = r.kp, embed_id = r.embed_id, origin_name = r.origin_name,
         is_series = coalesce(r.is_series, t.is_series),
         last_checked_at = now(), fill_tries = 0, source_changed = false,
         next_check_at = case when coalesce(r.embed_id, t.embed_id) is null
           or coalesce(nullif(r.kp, ''), nullif(t.kp, '')) is null
           then now() + case when t.first_seen_at > now() - interval '48 hours'
             then interval '4 hours' else interval '24 hours' end else null end
    from jsonb_to_recordset(p_rows) as r(id integer, kp text, embed_id integer, origin_name text, is_series boolean, failed boolean)
   where t.id = r.id and not coalesce(r.failed, false);
  get diagnostics n = row_count;
  update titles t set fill_tries = least(t.fill_tries::integer + 1, 32767), last_checked_at = now(),
    next_check_at = now() + case when t.fill_tries < 3 then interval '1 hour'
      when t.first_seen_at > now() - interval '48 hours' then interval '4 hours' else interval '24 hours' end
    from jsonb_to_recordset(p_rows) as r(id integer, failed boolean)
   where t.id = r.id and coalesce(r.failed, false);
  get diagnostics m = row_count;
  return n + m;
end
$fn$;

revoke all on function titles_upsert_catalog(jsonb) from public, anon, authenticated;
revoke all on function titles_fill(jsonb) from public, anon, authenticated;
grant execute on function titles_upsert_catalog(jsonb) to service_role;
grant execute on function titles_fill(jsonb) to service_role;

-- Reserve a portion of every batch for both new discoveries and due rechecks.
-- A missing identity is not a permanent verdict; failures cannot disappear.
create or replace function titles_pending(p_limit integer default 300)
returns table(id integer, slug text)
language sql security definer set search_path = public as $fn$
  with urgent as (
    select t.id, t.slug from titles t where t.next_check_at <= now()
      and (t.source_changed or t.first_seen_at > now() - interval '48 hours') and coalesce(t.slug, '') <> ''
    order by t.next_check_at, t.id desc limit greatest(1, least(p_limit, 1000) / 3)
  ), first_read as (
    select t.id, t.slug from titles t
    where t.last_checked_at is null and t.next_check_at is null
      and (t.kp is null or t.origin_name is null or t.embed_id is null)
      and coalesce(t.slug, '') <> ''
    order by t.id desc limit greatest(1, least(p_limit, 1000) / 3)
  ), due as (
    select t.id, t.slug from titles t where t.next_check_at <= now() and coalesce(t.slug, '') <> ''
      and t.id not in (select id from urgent)
    order by t.source_changed desc, t.next_check_at, t.id desc
    limit greatest(0, least(p_limit, 1000) - (select count(*) from urgent) - (select count(*) from first_read))
  ), extra_new as (
    select t.id, t.slug from titles t where t.last_checked_at is null and t.next_check_at is null
      and (t.kp is null or t.origin_name is null or t.embed_id is null) and coalesce(t.slug, '') <> ''
      and t.id not in (select id from first_read)
    order by t.id desc limit greatest(0, least(p_limit, 1000) - (select count(*) from urgent)
      - (select count(*) from first_read) - (select count(*) from due))
  ) select * from urgent union all select * from first_read union all select * from due union all select * from extra_new
    limit greatest(1, least(p_limit, 1000))
$fn$;
revoke all on function titles_pending(integer) from public, anon, authenticated;
grant execute on function titles_pending(integer) to service_role;
