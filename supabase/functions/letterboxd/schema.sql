-- Run once per project. `reviews` is nullable on purpose: a row written before
-- this column existed is indistinguishable from one whose film has no reviews
-- unless "never looked" stays representable, and only the former is worth
-- re-scraping for.
create table if not exists public.letterboxd (
  imdb text primary key,
  found boolean not null default false,
  r real,
  n bigint,
  slug text,
  reviews jsonb,
  updated_at timestamptz not null default now()
);
alter table public.letterboxd add column if not exists reviews jsonb;
