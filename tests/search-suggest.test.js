import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = () => readFile(new URL("../app.js", import.meta.url), "utf8");
const between = (t, a, b) => t.slice(t.indexOf(a), t.indexOf(b));

// Ranking and folding are the whole substance of a suggestion list, so they are
// tested as behaviour rather than by grepping for the implementation.
const fold = (v) => String(v || "").toLowerCase().replace(/ё/g, "е")
  .replace(/[^\p{L}\p{N}]+/gu, " ").trim();

const idx = (rows) => rows.map(([title, source = "catalog", origin = ""]) => ({
  title, source, folded: fold(title), originName: origin, foldedOrigin: fold(origin),
}));

// Both tiers are exercised through the real matchers rather than copies of them:
// a duplicate here would keep passing after app.js changed underneath it, which
// is exactly how English search shipped broken in the first place.
const { matchLocal, matchShard: realMatchShard } = await (async () => {
  const app = await source();
  const slice = (a, b) => app.slice(app.indexOf(a), app.indexOf(b));
  const body = [
    slice("const suggestFold = (value)", "function buildSuggestIndex"),
    "const SUGGEST_LOCAL_LIMIT = 6, SUGGEST_REMOTE_LIMIT = 6;",
    "let suggestIndex = [];",
    slice("  function matchLocalSuggest", "  // Shards live in IndexedDB"),
    slice("  // Exact first, then start-of-title", "function suggestRow(entry)"),
    slice("  // A local hit and an index hit", "  function onSuggestInput"),
    "return { matchShard, stillMatching, withoutLocal, matchLocal: (index, query) => {",
    "  suggestIndex = index; return matchLocalSuggest(query);",
    "} };",
  ].join("\n");
  return new Function(body)();
})();

const { stillMatching, withoutLocal } = await (async () => {
  const app = await source();
  const slice = (a, b) => app.slice(app.indexOf(a), app.indexOf(b));
  return new Function([
    slice("const suggestFold = (value)", "function buildSuggestIndex"),
    slice("  // Exact first, then start-of-title", "  function matchShard"),
    slice("  // A local hit and an index hit", "  function onSuggestInput"),
    "return { stillMatching, withoutLocal };",
  ].join("\n"))();
})();

const rank = (index, query) => matchLocal(index, query).map((e) => e.title);

test("a title that starts with what was typed outranks one where it starts a later word", () => {
  const index = idx([["Мистер Робот"], ["Загадочный мистер Фокс"], ["Мистерия"]]);
  assert.deepEqual(rank(index, "мистер"), ["Мистер Робот", "Мистерия", "Загадочный мистер Фокс"]);
});

test("a match buried inside a word is not a match", () => {
  // "мис" sits inside "Программисты" at position 7. Offering it reads as a bug,
  // which is why only word beginnings count.
  const index = idx([["Программисты"], ["Мистер Робот"]]);
  assert.deepEqual(rank(index, "мис"), ["Мистер Робот"]);
});

test("ё and case and punctuation do not decide whether a title is found", () => {
  const index = idx([["Ёлки"], ["Люди Икс ’97"]]);
  assert.deepEqual(rank(index, "елк"), ["Ёлки"]);
  assert.deepEqual(rank(index, "ЕЛКИ"), ["Ёлки"]);
  assert.deepEqual(rank(index, "люди икс 97"), ["Люди Икс ’97"]);
});

test("something already watched or saved comes before a catalogue entry that matches as well", () => {
  const index = idx([["Мистер Робот", "catalog"], ["Мистер Бин", "history"], ["Мистер Фон", "bookmark"]]);
  // All three are prefix matches, so only the source breaks the tie.
  assert.deepEqual(rank(index, "мистер"), ["Мистер Бин", "Мистер Фон", "Мистер Робот"]);
});

test("an empty or non-matching query yields nothing rather than everything", () => {
  const index = idx([["Мистер Робот"]]);
  assert.deepEqual(rank(index, ""), []);
  assert.deepEqual(rank(index, "   "), []);
  assert.deepEqual(rank(index, "зззз"), []);
});

test("the metered API is never in the typing path", async () => {
  const app = await source();
  const block = between(app, "const SUGGEST_DEBOUNCE_MS", "function onSearchSubmit()");
  // PoiskKino is the quota that runs out; a debounced query still fires several
  // requests, so it stays on Enter and typing costs it nothing.
  assert.doesNotMatch(block, /searchPoiskkino|resolverJson/);
  // Newdeaf is someone else's server — per-keystroke requests there are both
  // rude and a good way to get blocked.
  assert.doesNotMatch(block, /searchNewdeaf/);
  // The second tier is the mirrored index, fetched once per letter and matched
  // in the browser — not a per-keystroke call to anyone.
  assert.match(block, /loadShard\(/);
  assert.doesNotMatch(block, /searchLiftw\(/);
  assert.match(block, /SUGGEST_MIN_REMOTE = 3/);
  // The relay call is deferred, not fired on the keystroke that requested it.
  assert.match(block, /suggestTimer = setTimeout\(/);
  assert.match(block, /\}, SUGGEST_DEBOUNCE_MS\);/);
  // ...and a superseded timer is cancelled rather than left to fire.
  assert.match(block, /clearTimeout\(suggestTimer\)/);
});

test("a stale response cannot overwrite what the viewer is now typing", async () => {
  const app = await source();
  const block = between(app, "function onSuggestInput", "function onSearchSubmit()");
  // Two guards, because either alone leaks: the token catches a superseded
  // request, the value check catches one that resolved after further typing.
  assert.match(block, /token !== suggestToken/);
  assert.match(block, /el\.searchInput\.value\.trim\(\) !== query/);
});

test("a local hit opens without a resolve, and the list is rebuilt when the catalog changes", async () => {
  const app = await source();
  const choose = between(app, "function chooseSuggest", "function renderSuggest");
  // The whole point of tier 0: the entry already carries its target.
  assert.match(choose, /openCuratedItem\(\{/);
  assert.match(app, /alphy:catalog-refreshed[\s\S]{0,60}suggestIndex = null/);
  // getCatalog deep-clones 200KB; typeahead must not call it per keystroke.
  const build = between(app, "function buildSuggestIndex", "function matchLocalSuggest");
  assert.match(build, /suggestItems\?\.\(\)/);
  assert.doesNotMatch(build, /getCatalog\(\)/);
});

test("an index shard is fetched once per letter and then matched locally", async () => {
  const app = await source();
  const block = between(app, "function loadShard", "function matchShard");
  // Two caches, both needed: memory so repeat keystrokes cost nothing at all,
  // IndexedDB so a reload does not re-download ~100KB. localStorage would refuse
  // a shard that size and evict it besides.
  assert.match(block, /shardMemory\.has\(letter\)/);
  assert.match(block, /readShard\(letter\)/);
  assert.match(block, /Date\.now\(\) - cached\.at < TITLES_SHARD_TTL_MS/);
  assert.match(block, /writeShard\(letter/);
});

test("the index is served from Supabase, not from the Worker that builds it", async () => {
  const app = await source();
  // Cloudflare Workers are throttled from Russia, which is the audience. The
  // crawler stays there because it only ever talks to the source.
  assert.match(app, /TITLES_INDEX_URL = "https:\/\/[a-z]+\.supabase\.co/);
  // Scoped to the suggestion path: a legacy resolver constant elsewhere in the
  // file still names workers.dev and has nothing to do with this.
  const block = between(app, "function loadShard", "function suggestRow");
  assert.doesNotMatch(block, /workers\.dev/);
});

test("a suggestion without a known player id still opens", async () => {
  const app = await source();
  const block = between(app, "async function openIndexSuggestion", "function renderSuggest");
  // The backfill has reached under half the catalogue, so most rows carry only
  // a slug. Resolving it has to happen server-side: api.zombie-film.live does not
  // resolve from Russia at all.
  assert.match(block, /if \(!liftId\)/);
  assert.match(block, /\/resolve\?slug=/);
  assert.match(block, /liftwTarget\(liftId\)/);
});

test("index hits are ordered by match quality then by year, newest first", async () => {
  // `a - b || x < y ? 1 : -1` parses as `(a - b || x < y) ? 1 : -1`, which
  // discards the score and never compares years — the shipped list came out in
  // near-random order. This pins the comparator's actual behaviour.
  const rows = [
    { score: 1, entry: { year: "2020" } },
    { score: 0, entry: { year: "2015" } },
    { score: 0, entry: { year: "2019" } },
    { score: 0, entry: { year: "" } },
  ];
  const sorted = [...rows].sort((a, b) =>
    (a.score - b.score) || ((Number(b.entry.year) || 0) - (Number(a.entry.year) || 0)));
  assert.deepEqual(sorted.map((r) => `${r.score}:${r.entry.year || "-"}`),
    ["0:2019", "0:2015", "0:-", "1:2020"]);

  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.doesNotMatch(app, /a\.score - b\.score \|\| String\(/);
});

test("an exact title beats a newer one that merely starts with it", () => {
  // Ranking by recency alone put «Брат 3» (2022) above «Брат» (1997) and pushed
  // the film being searched for off a six-row list.
  const rank = (rows, q) => {
    const f = fold(q);
    return rows
      .map(([name, year]) => {
        const n = fold(name);
        const score = n === f ? 0 : (n.startsWith(f) ? 1 : (n.includes(` ${f}`) ? 2 : -1));
        return { name, year, score };
      })
      .filter((r) => r.score >= 0)
      .sort((a, b) => (a.score - b.score) || ((Number(b.year) || 0) - (Number(a.year) || 0)))
      .map((r) => `${r.name} (${r.year})`);
  };
  const rows = [["Брат 3", 2022], ["Брат", 1997], ["Братья", 2022], ["Мой брат", 2010]];
  assert.deepEqual(rank(rows, "брат"),
    ["Брат (1997)", "Брат 3 (2022)", "Братья (2022)", "Мой брат (2010)"]);
});

test("a suggestion row shows no type label, and a series still opens", async () => {
  const app = await source();
  const row = between(app, "function suggestRow(entry)", "function chooseSuggest");
  // The catalogue's type codes do not separate films from series — 1 and 2 are
  // films, 3, 4 and 5 all carry seasons — so the label was wrong about half the
  // time, and a confident wrong label is worse than none.
  assert.doesNotMatch(row, /"сериал"|"фильм"/);
  assert.match(row, /suggest-year/);
  assert.match(row, /suggest-origin/);
  // Series-ness still has to be right for the target, so it comes from the
  // backfilled flag rather than from the type code.
  const match = between(app, "function matchShard", "function suggestRow");
  assert.match(match, /isSeries: !!row\[3\]/);
  assert.doesNotMatch(match, /row\[3\] !== 1/);
});

test("a title is found by its original name, not only its Russian one", () => {
  // [name, year, slug, isSeries, embed_id, kp, originName]
  const rows = [
    ["Умница Уилл Хантинг", 1997, "umnica-uill-hanting", 0, null, "", "Good Will Hunting"],
    ["Гуд бай, Ленин!", 2003, "gud-bay-lenin", 0, 11, "", "Good Bye Lenin!"],
  ];
  assert.deepEqual(realMatchShard(rows, "good will hu").map((e) => e.title), ["Умница Уилл Хантинг"]);
  // Case and punctuation in the original title decide nothing either.
  assert.deepEqual(realMatchShard(rows, "GOOD BYE LENIN").map((e) => e.title), ["Гуд бай, Ленин!"]);
  // ...and the Russian name still works, unchanged.
  assert.deepEqual(realMatchShard(rows, "умница").map((e) => e.title), ["Умница Уилл Хантинг"]);
});

test("an original-title match ranks just behind an equally good Russian one", () => {
  const rows = [
    ["Северное сияние", 2020, "severnoe", 0, 1, "", "Northern Lights"],
    ["Разделение", 2022, "razdelenie", 1, 2, "", "Severance"],
  ];
  // Both are prefix matches for "sever"; the Russian name wins the tie, but the
  // original title is still offered rather than dropped.
  assert.deepEqual(
    realMatchShard(rows, "север").map((e) => e.title),
    ["Северное сияние"],
  );
  assert.deepEqual(
    realMatchShard(rows, "sever").map((e) => e.title),
    ["Разделение"],
  );
});

test("a match buried inside a word of the original title is not a match", () => {
  const rows = [["Овердрайв", 2017, "overdrive", 0, 1, "", "Overdrive"]];
  assert.deepEqual(realMatchShard(rows, "drive"), []);
  assert.deepEqual(realMatchShard(rows, "over").map((e) => e.title), ["Овердрайв"]);
});

test("a row with no original title is unaffected by original-title matching", () => {
  const rows = [["Брат", 1997, "brat", 0, 1, "", ""], ["Брат 3", 2022, "brat-3", 0, 2, "", null]];
  assert.deepEqual(realMatchShard(rows, "брат").map((e) => e.title), ["Брат", "Брат 3"]);
});

test("a shard holds titles matching either initial, and old cached shards are discarded", async () => {
  const app = await source();
  // Routing on the Russian initial alone is what made English search find
  // nothing: "Good…" loaded the shard of titles whose RUSSIAN name starts with
  // g, which «Умница Уилл Хантинг» is not in and never could be.
  const fn = await readFile(new URL("../supabase/functions/titles/index.ts", import.meta.url), "utf8");
  // A title belongs to the shard of every word it contains, in either language,
  // so the query is an array-contains rather than a pair of initials. Routing is
  // covered end to end in search-routing.test.js.
  assert.match(fn, /shard_keys=cs\.\$\{encodeURIComponent\(`\{"\$\{folded\}"\}`\)\}/);
  // Shards sit in the viewer's IndexedDB for a week, so changing what a shard
  // contains has to invalidate the copies already out there — and the version
  // has to reach the object path too, or a new shape would overwrite objects
  // that browsers and the CDN are still serving from the old one.
  assert.match(app, /TITLES_SHARD_VERSION = \d+/);
  const load = between(app, "function loadShard", "function suggestScore");
  assert.match(load, /`\$\{rawLetter\}:\$\{TITLES_SHARD_VERSION\}`/);
  const object = between(app, "const shardObject =", "const shardHostOrder");
  assert.match(object, /v\$\{TITLES_SHARD_VERSION\}/);
});

test("shards are read as static objects, not from the function", async () => {
  const app = await source();
  const fetchShard = between(app, "async function fetchShard", "const shardInFlight");
  // Cloudflare fronts Supabase Functions with cf-cache-status: DYNAMIC and never
  // caches one, so a shard served by the function re-read Postgres for every
  // viewer — measured at 2.25s against 0.20s for the cached Storage object.
  assert.match(fetchShard, /shardHostOrder\(rawLetter\)/);
  assert.match(fetchShard, /shardObject\(rawLetter\)/);
  assert.match(app, /TITLES_SHARD_HOSTS = \[/);
  assert.match(between(app, "const TITLES_SHARD_HOSTS", "const TITLES_SHARD_TTL_MS"),
    /storage\/v1\/object\/public/);
  // The function stays reachable, but only after every mirror has been tried:
  // it is the answer for a letter whose object has never been built.
  assert.ok(fetchShard.indexOf("TITLES_INDEX_URL") > fetchShard.indexOf("shardHostOrder"));
  // A missing object answers 400 with a NoSuchKey body, so `ok` is not enough
  // on its own to call something a shard.
  assert.match(fetchShard, /Array\.isArray\(rows\)/);
});

test("a letter always starts at the same mirror, and every mirror is tried", () => {
  // The ring, extracted rather than restated: with one host it is a no-op, and
  // adding a project has to keep a letter pinned to one CDN entry.
  const order = (hosts, letter) => {
    const start = letter.codePointAt(0) % hosts.length;
    return hosts.map((_, i) => hosts[(start + i) % hosts.length]);
  };
  const hosts = ["a", "b", "c", "d"];
  assert.deepEqual(order(["only"], "п"), ["only"]);
  // Stable per letter…
  assert.deepEqual(order(hosts, "п"), order(hosts, "п"));
  // …and every host is reachable as a fallback, none dropped.
  assert.deepEqual([...order(hosts, "т")].sort(), hosts);
  // Letters do not all land on the same host.
  const heads = new Set([..."абвгдежзик"].map((l) => order(hosts, l)[0]));
  assert.ok(heads.size > 1, "letters must spread across the ring");
});

test("an object is named by codepoint, so any alphabet gives an ASCII path", async () => {
  const app = await source();
  const shardObject = new Function("TITLES_SHARD_VERSION", [
    between(app, "const shardObject =", "const shardHostOrder"),
    "return shardObject;",
  ].join("\n"))(2);
  assert.equal(shardObject("п"), "v2/43f.json");
  assert.equal(shardObject("a"), "v2/61.json");
  // Not URL-safe as a path segment, and exactly why the codepoint is used.
  assert.equal(shardObject("«"), "v2/ab.json");
});

test("something already watched is findable by its English name too", () => {
  const index = idx([["Разделение", "history", "Severance"], ["Севастополь", "catalog"]]);
  assert.deepEqual(rank(index, "severance"), ["Разделение"]);
  assert.deepEqual(rank(index, "сев"), ["Севастополь"]);
});

test("another character narrows the list on screen instead of emptying it", () => {
  // What is already rendered when a cold shard is still being fetched. Keeping
  // the rows that still match is the difference between the list narrowing and
  // the list blinking out for the length of the debounce.
  const shown = [
    { title: "Атака Титанов: Последняя атака", folded: "атака титанов последняя атака", originName: "" },
    { title: "Атака титанов: Потерянные девочки", folded: "атака титанов потерянные девочки", originName: "Shingeki no Kyojin: Lost Girls" },
    { title: "Атакама", folded: "атакама", originName: "Atacama" },
  ];
  assert.deepEqual(stillMatching(shown, "атака тита").map((e) => e.title),
    ["Атака Титанов: Последняя атака", "Атака титанов: Потерянные девочки"]);
  // A row kept only by its original title survives too.
  assert.deepEqual(stillMatching(shown, "shingeki").map((e) => e.title),
    ["Атака титанов: Потерянные девочки"]);
  // And a character that rules everything out does empty it, rather than
  // leaving stale rows standing.
  assert.deepEqual(stillMatching(shown, "атакаz"), []);
});

test("a film already shown from history is not repeated by the index", () => {
  const local = [{ title: "Разделение", year: "2022" }];
  const remote = [
    { title: "Разделение", year: "2022" },
    { title: "Разделение", year: "2009" },
  ];
  assert.deepEqual(withoutLocal(remote, local).map((e) => e.year), ["2009"]);
});

test("a warm shard answers on the keystroke, with no timer and no empty frame", async () => {
  const app = await source();
  const block = between(app, "function onSuggestInput", "function onSearchSubmit()");
  // The shard for a letter is in memory from the second keystroke onward, so
  // there is nothing to wait for and nothing to clear in the meantime.
  assert.match(block, /const warm = prefixRows.get\(prefix\) \|\| shardInMemory\(/);
  const warmPath = block.slice(block.indexOf("const warm ="), block.indexOf("// Cold shard"));
  assert.match(warmPath, /renderSuggest\(local, suggestRemote\)/);
  assert.doesNotMatch(warmPath, /setTimeout/);
  // Nothing on any path renders an empty remote list just to refill it.
  assert.doesNotMatch(block, /renderSuggest\(local, \[\]\)/);
});

test("an unchanged list is not rebuilt, and the divider carries no caption", async () => {
  const app = await source();
  const render = between(app, "function renderSuggest", "function closeSuggest");
  // Recreating identical rows is a repaint and loses the highlighted row.
  assert.match(render, /signature === suggestSignature/);
  // The two groups differ only in where the rows came from, which is ours to
  // know and not the viewer's.
  assert.doesNotMatch(render, /ещё в источниках/);
  assert.doesNotMatch(app, /ещё в источниках/);
});

test("a wedged IndexedDB costs the cache, not the search", async () => {
  const app = await source();
  const store = between(app, "function shardStore()", "async function readShard");
  // open() can fire none of success/error: another tab on an older version
  // blocks it, and a pending deleteDatabase wedges it until the tab closes.
  // An unsettled promise there stops every shard fetch, silently.
  assert.match(store, /onblocked = \(\) => resolve\(null\)/);
  assert.match(store, /setTimeout\(\(\) => resolve\(null\)/);
});

test("a cold shard is fetched once however fast the viewer types", async () => {
  const app = await source();
  const load = between(app, "const shardInFlight", "// [name, year, slug");
  // The debounce only cancels a timer that has not fired. Once a load starts,
  // the next keystroke schedules another 260ms later, and a cold shard takes
  // longer than that on a phone — measured at three parallel fetches of one
  // 776KB object.
  assert.match(load, /shardInFlight\.get\(letter\)/);
  assert.match(load, /if \(pending\) return pending/);
  assert.match(load, /shardInFlight\.set\(letter, load\)/);
  // A rejected load must not pin the letter for the rest of the session.
  assert.match(load, /\.finally\(\(\) => shardInFlight\.delete\(letter\)\)/);
});

test("concurrent loads of one letter share a single fetch", async () => {
  const app = await source();
  const slice = (a, b) => app.slice(app.indexOf(a), app.indexOf(b));
  let fetches = 0;
  const harness = new Function("hooks", [
    "const { onFetch, TITLES_SHARD_VERSION } = hooks;",
    "const shardMemory = new Map();",
    "const readShard = async () => null;",
    "const writeShard = () => {};",
    "const TITLES_SHARD_TTL_MS = 1e9;",
    "const TITLES_SHARD_FRESH_MS = 1e9;",
    "const fetchShard = async () => { onFetch(); await new Promise(r => setTimeout(r, 40)); return { rows: [['x']], etag: 'e1' }; };",
    slice("  // In flight, by letter.", "  // [name, year, slug"),
    "return loadShard;",
  ].join("\n"))({ onFetch: () => { fetches += 1; }, TITLES_SHARD_VERSION: 2 });

  const all = await Promise.all(["п", "п", "п", "п"].map((l) => harness(l)));
  assert.equal(fetches, 1, "four concurrent asks for one letter must cost one fetch");
  assert.deepEqual(all[0], [["x"]]);
  // And once it is in memory, later asks cost nothing at all.
  await harness("п");
  assert.equal(fetches, 1);
  // A different letter is still its own fetch.
  await harness("с");
  assert.equal(fetches, 2);
});

test("an older exact match is not lost behind newer partial ones", async () => {
  // 500 newer titles that merely start with the query, and the exact match last
  // — the order a shard actually arrives in, year descending. Capping the
  // candidate list before ranking dropped the only row that mattered.
  const rows = [];
  for (let i = 0; i < 500; i += 1) rows.push([`Че${i} и другие`, 2026, `c${i}`, 0, i, "", ""]);
  rows.push(["Че!", 1969, "che", 0, 999, "", ""]);
  assert.equal(realMatchShard(rows, "че")[0].title, "Че!");
});
