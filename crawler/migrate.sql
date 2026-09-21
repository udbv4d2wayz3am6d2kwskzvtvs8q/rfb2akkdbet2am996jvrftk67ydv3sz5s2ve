-- SQLite's lower() is ASCII-only, so "Мистер" never folds to "мистер" and a
-- Cyrillic shard query matched nothing. The folded initial is computed in JS,
-- where toLowerCase() is Unicode-aware, and stored.
alter table titles add column initial text;
create index if not exists titles_initial on titles (initial);
