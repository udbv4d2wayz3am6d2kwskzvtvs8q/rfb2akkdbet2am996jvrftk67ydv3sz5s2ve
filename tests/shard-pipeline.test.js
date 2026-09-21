import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const fn = () => readFile(new URL("../supabase/functions/titles/index.ts", import.meta.url), "utf8");
const schema = () => readFile(new URL("../supabase/functions/titles/schema.sql", import.meta.url), "utf8");
const script = () => readFile(new URL("../scripts/build-title-shards.mjs", import.meta.url), "utf8");

test("shard invalidation is the database's job, not a writer's", async () => {
  const sql = await schema();
  // Computing the touched letters inside the ingest handler meant /resolve —
  // which writes to the same table — queued nothing, so the rows it wrote
  // reached Postgres and no shard, and viewers read a stale snapshot forever.
  assert.match(sql, /create trigger titles_shard_dirty_ins\s+after insert on titles/);
  assert.match(sql, /create trigger titles_shard_dirty_upd\s+after update of/);
  // A rename leaves some shards and enters others; both sides are stale.
  assert.match(sql, /coalesce\(new\.shard_keys, '\{\}'::text\[\]\)/);
  assert.match(sql, /case when tg_op = 'UPDATE' then coalesce\(old\.shard_keys, '\{\}'::text\[\]\)/);
  // Without DISTINCT a row whose two initials coincide proposes the same key
  // twice and ON CONFLICT DO UPDATE aborts the caller's write outright.
  assert.match(sql, /select distinct letter, now\(\)/);
  // The mark must move on every write, or a build in flight cannot tell that
  // its snapshot went stale.
  assert.match(sql, /on conflict \(letter\) do update set marked_at = excluded\.marked_at/);

  const source = await fn();
  const ingest = source.slice(source.indexOf("// Ingest, from the Cloudflare crawler only."),
    source.indexOf("if (url.pathname.endsWith(\"/resolve\")"));
  assert.doesNotMatch(ingest, /touched/);
  assert.doesNotMatch(ingest, /ignore-duplicates/);
});

test("a letter re-marked mid-build stays queued", async () => {
  const source = await fn();
  const build = source.slice(source.indexOf('if (url.pathname.endsWith("/build")'),
    source.indexOf("// Ingest, from the Cloudflare crawler only."));
  // The timestamps are read before anything is built...
  assert.match(build, /select=letter,marked_at/);
  assert.match(build, /const marks = new Map\(/);
  // ...and the delete afterwards is conditional on them. An unconditional
  // delete threw away a mark that arrived while the letter was being built.
  assert.match(build, /marked_at=eq\.\$\{encodeURIComponent\(mark\)\}/);
  assert.match(build, /const mark = marks\.get\(letter\)/);

  // The operator script runs the same risk and takes the same precaution.
  const full = await script();
  assert.match(full, /shard_dirty\?select=letter,marked_at/);
  assert.match(full, /marked_at=eq\.\$\{encodeURIComponent\(mark\)\}/);
});

test("enrichment never regresses to null", async () => {
  const sql = await schema();
  const fn = sql.slice(sql.indexOf("create or replace function titles_before_write"),
    sql.indexOf("drop trigger if exists titles_initials_trg"));
  // Two independent writers own these columns: the crawler, publishing whole
  // rows out of its own D1 copy, and /resolve, writing straight to Postgres. A
  // title a viewer resolved was reset to null the next time the crawler
  // republished the row it still had as unresolved.
  for (const column of ["embed_id", "is_series"]) {
    assert.match(fn, new RegExp(`new\\.${column}\\s*:= coalesce\\(new\\.${column}, old\\.${column}\\)`));
  }
  for (const column of ["kp", "origin_name"]) {
    assert.ok(fn.includes(`coalesce(nullif(new.${column}, ''), old.${column}, new.${column})`));
  }
  // Only on update — there is no OLD to fall back to on an insert.
  assert.match(fn, /if tg_op = 'UPDATE' then/);
  // One BEFORE trigger, because two would depend on Postgres firing them in
  // alphabetical order by name.
  assert.match(sql, /create trigger titles_before_write\s+before insert or update on titles/);
  assert.doesNotMatch(sql, /create trigger titles_initials_trg/);
});

test("resolve answers from our own table when it already knows", async () => {
  const source = await fn();
  const resolve = source.slice(source.indexOf('if (url.pathname.endsWith("/resolve")'),
    source.indexOf("if (url.pathname.endsWith(\"/count\")"));
  // Every valid slug is public — they are printed in shards anyone can download
  // — so a resolve that always went upstream was an unmetered way to drive
  // traffic at the source through us.
  assert.match(resolve, /select=id,name,embed_id,kp,origin_name,is_series/);
  const shortcut = resolve.indexOf("if (row.embed_id)");
  assert.ok(shortcut > 0, "known rows must answer without asking upstream");
  // Against the call site, not the hostname: the hostname also appears in the
  // comment explaining why this exists, which is not evidence of anything.
  assert.ok(shortcut < resolve.indexOf('await ask("")'),
    "the short circuit has to come before the upstream call");
});
