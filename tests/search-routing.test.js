import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
const slice = (a, b) => app.slice(app.indexOf(a), app.indexOf(b));

// The whole point of this file: every earlier suggestion test handed `rows`
// straight to matchShard, so routing — which shard a query loads, and which
// shard a title was written into — was never exercised at all. Both of the two
// worst bugs in this feature lived exactly there: the matcher could match the
// string, and the router never delivered the string to the matcher.
const { suggestFold, matchShard, shardObject } = new Function([
  slice("const suggestFold = (value)", "function buildSuggestIndex"),
  "const SUGGEST_REMOTE_LIMIT = 6;",
  "const TITLES_SHARD_VERSION = 3;",
  slice("  const shardObject =", "  const shardHostOrder"),
  slice("  // Exact first, then start-of-title", "function suggestRow(entry)"),
  "return { suggestFold, matchShard, shardObject };",
].join("\n"))();

// The indexer's rule, mirrored from shard_keys_of() in schema.sql: the first
// character of every word, across the Russian name and the original one.
const shardKeysOf = (name, origin) => [...new Set(
  `${name || ""} ${origin || ""}`
    .toLowerCase().replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim().split(" ").filter(Boolean)
    .map((word) => word[0]),
)];

// index rows -> build shards -> pick the shard the client would pick -> match.
function search(rows, query) {
  const shards = new Map();
  for (const row of rows) {
    for (const key of shardKeysOf(row[0], row[6])) {
      if (!shards.has(key)) shards.set(key, []);
      shards.get(key).push(row);
    }
  }
  const folded = suggestFold(query);
  if (folded.length < 3) return [];           // SUGGEST_MIN_REMOTE
  const letter = folded[0];                    // what loadShard is asked for
  return matchShard(shards.get(letter) || [], query).map((e) => e.title);
}

const CATALOGUE = [
  ["Пираты Карибского моря: Проклятие Чёрной жемчужины", 2003, "potc", 0, 1, "",
    "Pirates of the Caribbean: The Curse of the Black Pearl"],
  ["Умница Уилл Хантинг", 1997, "gwh", 0, 2, "", "Good Will Hunting"],
  ["Во все тяжкие", 2008, "bb", 1, 3, "", "Breaking Bad"],
  ["Карибский кризис", 2010, "kk", 0, 4, "", ""],
  ["Мистер Робот", 2015, "mr", 1, 5, "", "Mr. Robot"],
];

test("a word inside the title is reachable, not just the first one", () => {
  // Typing this loads shard «к». The row's only initial is «п», so before
  // shard_keys it was not in that shard and could never be offered.
  assert.deepEqual(search(CATALOGUE, "карибского"),
    ["Пираты Карибского моря: Проклятие Чёрной жемчужины"]);
  assert.deepEqual(search(CATALOGUE, "жемчужины"),
    ["Пираты Карибского моря: Проклятие Чёрной жемчужины"]);
  assert.deepEqual(search(CATALOGUE, "тяжкие"), ["Во все тяжкие"]);
});

test("a word inside the ORIGINAL title is reachable too", () => {
  // "will hunting" loads shard «w»; the row's original title starts with G.
  assert.deepEqual(search(CATALOGUE, "will hunting"), ["Умница Уилл Хантинг"]);
  assert.deepEqual(search(CATALOGUE, "hunting"), ["Умница Уилл Хантинг"]);
  assert.deepEqual(search(CATALOGUE, "caribbean"),
    ["Пираты Карибского моря: Проклятие Чёрной жемчужины"]);
  assert.deepEqual(search(CATALOGUE, "black pearl"),
    ["Пираты Карибского моря: Проклятие Чёрной жемчужины"]);
});

test("the title's own beginning still routes and still wins", () => {
  assert.deepEqual(search(CATALOGUE, "пираты"),
    ["Пираты Карибского моря: Проклятие Чёрной жемчужины"]);
  // «Карибский кризис» starts with the query; the Pirates film merely contains
  // it as a later word. Both are in shard «к», and the exact-prefix wins.
  assert.deepEqual(search(CATALOGUE, "карибский")[0], "Карибский кризис");
});

test("a query below the client's minimum never routes anywhere", () => {
  // Two characters do not reach the index tier at all, whatever they match.
  assert.deepEqual(search(CATALOGUE, "во"), []);
  assert.deepEqual(search(CATALOGUE, "мр"), []);
});

test("punctuation decides neither the shard nor the match", () => {
  // «Mr. Robot» tokenises to mr + robot; the dot is not a letter.
  assert.deepEqual(search(CATALOGUE, "robot"), ["Мистер Робот"]);
  assert.deepEqual(search(CATALOGUE, "мистер"), ["Мистер Робот"]);
});

test("the object a letter maps to is ASCII whatever the alphabet", () => {
  assert.equal(shardObject("к"), "v3/43a.json");
  assert.equal(shardObject("w"), "v3/77.json");
});

test("the JS rule used above matches the SQL that actually builds the shards", async () => {
  const sql = await readFile(new URL("../supabase/functions/titles/schema.sql", import.meta.url), "utf8");
  const fn = sql.slice(sql.indexOf("create or replace function shard_keys_of"),
    sql.indexOf("alter table titles add column if not exists shard_keys"));
  // Same three decisions, in the same order: split on runs of non-alphanumerics,
  // lowercase, fold ё to е, take the first character of each word.
  assert.match(fn, /regexp_replace\(coalesce\(p_name, ''\) \|\| ' ' \|\| coalesce\(p_origin, ''\), '\[\^\[:alnum:\]\]\+', ' ', 'g'\)/);
  assert.match(fn, /lower\(left\(w, 1\)\)/);
  assert.match(fn, /replace\(lower\(left\(w, 1\)\), 'ё', 'е'\)/);
  assert.match(fn, /array_agg\(distinct letter\)/);
});
