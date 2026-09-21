import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { makeSandbox, sleep } from "./helpers/app-sandbox.js";

// The rating lives behind four identical Supabase Edge deployments. These
// tests pin the two properties that
// matter: a film is always asked of the same project, and one project being
// down costs the next caller nothing.

// The app runs in a vm, so its objects carry that realm's prototypes and
// deepStrictEqual would compare identities rather than values.
const plain = (value) => JSON.parse(JSON.stringify(value));

async function boot({ handler, storageSeed = new Map() } = {}) {
  const ctx = makeSandbox({ storageSeed });
  ctx.run();
  await sleep(80);
  const calls = [];
  if (handler) {
    ctx.sandbox.fetch = async (url, opts) => {
      calls.push(String(url));
      return handler(String(url), opts, calls.length);
    };
  }
  return { helpers: ctx.sandbox.window.alphyBridge._test, calls, storage: ctx.storage, ctx };
}

const ok = (body) => ({ ok: true, status: 200, headers: { get: () => "" }, json: async () => body });

test("a film always goes to the same project, and the ring is the failover order", async () => {
  const { helpers } = await boot();
  const endpoints = helpers.LETTERBOXD_ENDPOINTS;
  assert.equal(endpoints.length, 5);
  assert.ok(endpoints.every((url) => /^https:\/\/[a-z]+\.supabase\.co\/functions\/v1\/letterboxd$/.test(url)));

  // Deterministic: the same id always starts at the same project.
  const first = helpers.letterboxdEndpointOrder("tt0111161");
  assert.deepEqual(plain(first), plain(helpers.letterboxdEndpointOrder("tt0111161")));
  // Every order is a full permutation, so a failure can always fall through.
  for (const id of ["tt0111161", "tt0137523", "tt6751668", "tt1877830"]) {
    const order = helpers.letterboxdEndpointOrder(id);
    assert.deepEqual(plain(order).sort(), plain(endpoints).sort(), `${id} lost an endpoint`);
  }
  // And the load actually spreads rather than pinning everything to one.
  const starts = new Set();
  for (let i = 1000; i < 1200; i += 1) starts.add(helpers.letterboxdEndpointOrder(`tt${i}0000`)[0]);
  assert.equal(starts.size, 5, "ids should reach every managed project");
});

test("a fifth project takes a fifth of the films and moves nobody else", async () => {
  const { helpers } = await boot();
  const shard = (hash, count) => helpers.letterboxdShardIndex(hash, count);
  let moved = 0, toNew = 0;
  const total = 20000;
  for (let hash = 7; hash < 7 + total; hash += 1) {
    const before = shard(hash, 4), after = shard(hash, 5);
    assert.equal(before, hash % 4, "the first four keep the placement they always had");
    if (after !== before) { moved += 1; assert.equal(after, 4, "a film only ever moves to the new project"); }
    if (after === 4) toNew += 1;
  }
  assert.equal(moved, toNew);
  assert.ok(Math.abs(toNew / total - 0.2) < 0.01, `new project share ${toNew / total}`);
});

test("every serving shard is managed by the deploy matrix", async () => {
  const { helpers } = await boot();
  const workflow = await readFile(new URL("../.github/workflows/deploy-letterboxd.yml", import.meta.url), "utf8");
  for (const endpoint of helpers.LETTERBOXD_ENDPOINTS) {
    const ref = new URL(endpoint).hostname.split(".")[0];
    assert.match(workflow, new RegExp(`project: ${ref}\\b`), `${ref} cannot be deployed`);
  }
  assert.doesNotMatch(workflow, /project: lcldjrphnkufymdhevyx\b/,
    "an undeployable legacy shard must not return to the serving ring");
  assert.match(workflow, /node scripts\/deploy-letterboxd-schema\.mjs/);
});

test("a rating is fetched once and then served from storage", async () => {
  const { helpers, calls, storage } = await boot({
    handler: () => ok({ imdb: "tt0111161", found: true, slug: "the-shawshank-redemption", r: 4.6, n: 3008699 }),
  });
  // The slug rides along so the watch-page badge can link out to the film.
  const expected = { r: 4.6, n: 3008699, slug: "the-shawshank-redemption" };
  assert.deepEqual(plain(await helpers.letterboxdRating("tt0111161")), expected);
  assert.deepEqual(plain(await helpers.letterboxdRating("tt0111161")), expected);
  assert.equal(calls.length, 1, "the second ask must not touch the network");
  assert.ok([...storage.keys()].some((k) => k.endsWith("letterboxd.v1:tt0111161")));
});

test("a title Letterboxd does not carry is remembered as a miss", async () => {
  // Letterboxd is a film site: a series has no page at all. Re-asking on every
  // open would spend a request per view for a verdict that cannot change.
  const { helpers, calls, storage } = await boot({ handler: () => ok({ imdb: "tt0903747", found: false }) });
  assert.equal(await helpers.letterboxdRating("tt0903747"), null);
  assert.equal(await helpers.letterboxdRating("tt0903747"), null);
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(storage.get("alphy.cache.letterboxd.v1:tt0903747")).v.r, 0);
});

test("a dead project is skipped, and stops being tried for a while", async () => {
  const initial = await boot();
  const dead = initial.helpers.letterboxdEndpointOrder("tt0137523")[0];
  const { helpers, calls } = await boot({
    handler: (url) => {
      if (url.startsWith(dead)) throw new Error("project paused");
      return ok({ found: true, r: 4.27, n: 5862630 });
    },
  });
  // The chosen id starts on the dead project, so this exercises fall-through.
  const order = helpers.letterboxdEndpointOrder("tt0137523");
  assert.equal(order[0], dead);
  assert.deepEqual(plain(await helpers.letterboxdRating("tt0137523")), { r: 4.27, n: 5862630, slug: "" });
  assert.equal(calls.length, 2, "one failure, then the next project answers");

  // The dead one is now on cooldown: another id that would have started there
  // skips it outright instead of paying the same timeout again.
  const before = calls.length;
  await helpers.letterboxdRating("tt7654321");
  assert.equal(calls.length - before, 1, "the cooling project must not be retried");
});

test("an upstream-unreachable answer falls through and is never cached as a miss", async () => {
  const { helpers, calls, storage } = await boot({
    handler: (_url, _opts, number) => (
      number === 1
        ? ok({ imdb: "tt0111161", found: false, unreachable: true })
        : ok({ imdb: "tt0111161", found: true, slug: "shawshank", r: 4.6, n: 10 })
    ),
  });
  assert.equal((await helpers.letterboxdRating("tt0111161"))?.r, 4.6);
  assert.equal(calls.length, 2, "the next shard should get a chance to answer");
  assert.equal(JSON.parse(storage.get("alphy.cache.letterboxd.v1:tt0111161")).v.r, 4.6);
});

test("nothing but an IMDb id ever reaches the network", async () => {
  const { helpers, calls } = await boot({ handler: () => ok({ found: true, r: 4 }) });
  for (const bad of ["", null, "tt", "123456", "../../etc", "tt1;rm -rf", "javascript:alert(1)"]) {
    assert.equal(await helpers.letterboxdRating(bad), null, `${JSON.stringify(bad)} was accepted`);
  }
  assert.deepEqual(calls, []);
});

test("an out-of-range score is treated as no score at all", async () => {
  // The 0-5 scale is the one thing the badge relies on; a 0-10 value would be
  // rendered as if it were stars.
  for (const r of [0, -1, 9.1, "abc", null]) {
    const { helpers } = await boot({ handler: () => ok({ found: true, r }) });
    assert.equal(await helpers.letterboxdRating("tt0111161"), null, `r=${r} leaked through`);
  }
});

test("the badge is appended, never rendered inline, and is skipped for series", async () => {
  const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const start = source.indexOf("function fillLetterboxdBadge");
  const block = source.slice(start, start + 1100);
  assert.ok(start > 0);
  // It must not be able to hold up the sidebar.
  assert.match(block, /letterboxdImdbId\(meta\)[\s\S]*\.then\(/);
  assert.match(block, /meta\?\.isSeries/);
  // A late answer must not land on a page the user has already navigated away from.
  assert.match(block, /letterboxdWatchIsCurrent\(target, token\)/);
  const guardStart = source.indexOf("function letterboxdWatchIsCurrent");
  const guard = source.slice(guardStart, guardStart + 420);
  assert.match(guard, /isStale\(token\)/);
  assert.match(guard, /state\.currentMeta\?\.isSeries/);
  assert.match(guard, /keyFor\(state\.currentTarget\) === keyFor\(target\)/);
});

test("a film badge cannot survive a route change or a late series correction", async () => {
  const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const renderStart = source.indexOf("function renderMeta");
  const renderEnd = source.indexOf("function linkImdbBadge", renderStart);
  const render = source.slice(renderStart, renderEnd);
  assert.match(render, /canPreserveLetterboxd = !isSeries/,
    "a title corrected to series must discard a film badge");
  assert.match(render, /dataset\.watchToken === String\(resolveToken\)/,
    "only a badge created by this navigation may be reused");
  assert.match(render, /dataset\.targetKey === keyFor\(target\)/,
    "only a badge owned by this title may be reused");
  assert.match(render, /state\.currentMeta\?\.isSeries === true[\s\S]*meta\.isSeries === true[\s\S]*target\?\.isSeries === true/,
    "a late authoritative series type must replace an early film-shaped placeholder");

  const showStart = source.indexOf("async function showWatch");
  const show = source.slice(showStart, showStart + 1100);
  assert.match(show, /metaPanel\.replaceChildren\(\)/,
    "new watch routes must not retain the previous title's DOM");

  const badgeStart = source.indexOf("function fillLetterboxdBadge");
  const badgeEnd = source.indexOf("async function letterboxdImdbId", badgeStart);
  const badge = source.slice(badgeStart, badgeEnd);
  assert.match(badge, /letterboxdWatchIsCurrent\(target, token\)/,
    "late network answers must re-check the current title type");
  assert.match(badge, /node\.dataset\.targetKey = keyFor\(target\)/,
    "new badges must carry explicit title ownership");
});

test("a grid asks once per shard and never triggers scraping", async () => {
  const asked = [];
  const { helpers, storage } = await boot({
    handler: (url) => {
      asked.push(url);
      const ids = new URL(url).searchParams.get("imdb").split(",");
      // The table answers only what it holds; an unknown film is simply absent.
      const items = {};
      for (const id of ids) if (id !== "tt9999999") items[id] = { r: 4.1, n: 100, slug: `s-${id}` };
      return ok({ items });
    },
  });
  const ids = ["tt0111161", "tt0137523", "tt6751668", "tt1877830", "tt9999999"];
  await helpers.letterboxdBatch(ids);

  // One request per shard, not one per film.
  assert.ok(asked.length <= 4 && asked.length >= 1, `${asked.length} requests for ${ids.length} films`);
  assert.ok(asked.every((url) => url.includes(",") || new URL(url).searchParams.get("imdb").split(",").length >= 1));
  // Every id went to the shard its hash picks, so batch and single agree.
  for (const url of asked) {
    const endpoint = url.split("?")[0];
    for (const id of new URL(url).searchParams.get("imdb").split(",")) {
      assert.equal(helpers.letterboxdEndpointOrder(id)[0], endpoint, `${id} went to the wrong shard`);
    }
  }
  assert.equal(JSON.parse(storage.get("alphy.cache.letterboxd.v1:tt0111161")).v.r, 4.1);
  // A film the table has never seen must stay unknown rather than be cached as
  // "no rating" — opening it later is what fills it in.
  assert.equal(storage.get("alphy.cache.letterboxd.v1:tt9999999"), undefined);
});

test("a batch never re-asks for something already cached", async () => {
  const asked = [];
  const { helpers } = await boot({
    handler: (url) => { asked.push(url); return ok({ items: { tt0111161: { r: 4.6, n: 1, slug: "x" } } }); },
  });
  await helpers.letterboxdBatch(["tt0111161"]);
  await helpers.letterboxdBatch(["tt0111161"]);
  assert.equal(asked.length, 1);
});

test("a film the server could not answer for is still asked only once", async () => {
  // A search grid renders twice, and an unanswerable film leaves nothing in the
  // cache to suppress the second pass — which is how one grid became four calls.
  const asked = [];
  const { helpers } = await boot({
    handler: (url) => { asked.push(url); return ok({ items: {} }); },
  });
  await helpers.letterboxdBatch(["tt0111161", "tt0137523"]);
  await helpers.letterboxdBatch(["tt0111161", "tt0137523"]);
  assert.equal(asked.length, 2, "two shards, one pass — not two passes");
});

test("a second render pass waits for the first request instead of painting early", async () => {
  // The grid renders twice and the second pass builds new card elements. If it
  // skipped the in-flight request it would read an empty cache and paint nothing.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const asked = [];
  const { helpers, storage } = await boot({
    handler: async (url) => {
      asked.push(url);
      await gate;
      return ok({ items: { tt0111161: { r: 4.6, n: 7, slug: "x" } } });
    },
  });
  const first = helpers.letterboxdBatch(["tt0111161"]);
  const second = helpers.letterboxdBatch(["tt0111161"]);
  release();
  await Promise.all([first, second]);
  assert.equal(asked.length, 1, "the second pass must not fire its own request");
  assert.equal(JSON.parse(storage.get("alphy.cache.letterboxd.v1:tt0111161")).v.r, 4.6,
    "and it must not return before the cache is filled");
});

test("a shard still on the old single-film shape is still understood", async () => {
  // Shards deploy independently. One lagging must cost its own films at worst,
  // never the whole grid's numbers.
  const { helpers, storage } = await boot({
    handler: () => ok({ imdb: "tt0780504", found: true, slug: "drive-2011", r: 3.91, n: 2034887 }),
  });
  await helpers.letterboxdBatch(["tt0780504"]);
  const cached = JSON.parse(storage.get("alphy.cache.letterboxd.v1:tt0780504")).v;
  assert.equal(cached.r, 3.91);
  assert.equal(cached.slug, "drive-2011");
});

test("the score is doubled for display but stored and linked at its true scale", async () => {
  const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
  // Doubling lives in exactly one place, so the card and the sidebar can never
  // disagree about what scale the number is on.
  const helper = source.match(/const letterboxdOutOfTen = [^;]+;/);
  assert.ok(helper, "letterboxdOutOfTen must exist");
  assert.match(helper[0], /\* 2\)\.toFixed\(1\)/);

  // Two call sites: the cover card and the sidebar badge.
  const uses = source.match(/letterboxdOutOfTen\(/g) ?? [];
  assert.equal(uses.length, 2, `expected the card and the sidebar to use it, saw ${uses.length}`);

  // 3.65 out of 5 is 7.3 out of 10 — one decimal, same width as the badges beside it.
  const outOfTen = (score) => (Number(score) * 2).toFixed(1);
  assert.equal(outOfTen(3.65), "7.3");
  assert.equal(outOfTen(4.46), "8.9");
  assert.equal(outOfTen(4), "8.0");

  // The link and the tooltip must still quote Letterboxd's own 0-5 scale.
  const badgeStart = source.indexOf("function fillLetterboxdBadge");
  const badgeEnd = source.indexOf("async function letterboxdImdbId", badgeStart);
  const badge = source.slice(badgeStart, badgeEnd);
  assert.match(badge, /rating\.r\.toFixed\(2\)\} из 5 на Letterboxd/);
});

test("the card puts the score on its own line above the runtime, not in the ratings row", async () => {
  const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const start = source.indexOf("function setCardLetterboxd");
  const block = source.slice(start, start + 1200);
  assert.ok(start > 0);
  // Three figures across one row forced all of them smaller; the score is now a
  // row of its own, so nothing shrinks.
  assert.doesNotMatch(block, /has-three/);
  assert.doesNotMatch(block, /hover-rating-divider/);
  assert.match(block, /querySelector\?\.\("\.card-hover-meta"\)/);
  // Whichever lands first, the runtime stays at the bottom of the stack.
  assert.match(block, /insertBefore\(row, runtime\)/);

  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /hover-ratings\.has-three/, "the shrinking rule must be gone");
});

// --- one queue for the whole page -------------------------------------------
// A home visit used to cost 32 function calls: every row asked every shard on
// its own, and a film our table had never seen was asked again on every visit.

const idsOf = (url) => new URL(url).searchParams.get("imdb").split(",");

function fakeCard({ imdb = "", lb = null } = {}) {
  const painted = [];
  const hover = {
    querySelector: (selector) => (selector === ".hover-rating-lb" && painted.length ? {} : null),
    appendChild: (row) => { painted.push(row.innerHTML); return row; },
    insertBefore: (row) => { painted.push(row.innerHTML); return row; },
  };
  const dataset = {};
  if (imdb) dataset.imdb = imdb;
  if (lb) dataset.lb = JSON.stringify(lb);
  return { dataset, painted, querySelector: (selector) => (selector === ".card-hover-meta" ? hover : null) };
}
const fakeGrid = (cards) => ({ querySelectorAll: () => cards });

test("rows rendered together share one request per shard, not one per row", async () => {
  const asked = [];
  const { helpers } = await boot({ handler: (url) => { asked.push(url); return ok({ items: {} }); } });
  const rows = Array.from({ length: 12 }, (_, row) =>
    Array.from({ length: 10 }, (_, i) => `tt${2000000 + row * 10 + i}`));
  await Promise.all(rows.map((ids) => helpers.letterboxdBatch(ids)));

  const perShard = new Map();
  for (const id of rows.flat()) {
    const shard = helpers.letterboxdEndpointOrder(id)[0];
    perShard.set(shard, (perShard.get(shard) || 0) + 1);
  }
  const expected = [...perShard.values()].reduce((sum, n) => sum + Math.ceil(n / 60), 0);
  assert.equal(asked.length, expected, `${asked.length} requests for twelve rows`);
  assert.ok(asked.length <= helpers.LETTERBOXD_ENDPOINTS.length, "at most one request per shard");
  const sent = asked.flatMap(idsOf);
  assert.equal(sent.length, 120, "no film may be asked twice");
  assert.equal(new Set(sent).size, 120, "and none may be left out");
});

test("more than sixty films for one shard are split, never cut short", async () => {
  const asked = [];
  const { helpers } = await boot({ handler: (url) => { asked.push(url); return ok({ items: {} }); } });
  const shard = helpers.LETTERBOXD_ENDPOINTS[0];
  const ids = [];
  for (let n = 3000000; ids.length < 150; n += 1) {
    if (helpers.letterboxdEndpointOrder(`tt${n}`)[0] === shard) ids.push(`tt${n}`);
  }
  await helpers.letterboxdBatch(ids);
  assert.equal(asked.length, 3);
  assert.ok(asked.every((url) => url.startsWith(shard) && idsOf(url).length <= 60));
  assert.deepEqual(asked.flatMap(idsOf).sort(), [...ids].sort(), "the function reads only sixty per call");
});

test("a film our table has never seen is not re-asked next visit, and opening it still fills it in", async () => {
  const first = await boot({ handler: () => ok({ items: {} }) });
  await first.helpers.letterboxdBatch(["tt0111161"]);
  assert.equal(first.calls.length, 1);
  // "Unknown" is a fact about our cache, not a verdict: it must not look like one.
  assert.equal(first.storage.get("alphy.cache.letterboxd.v1:tt0111161"), undefined);

  const second = await boot({
    storageSeed: first.storage,
    handler: (url) => (url.includes("mode=batch")
      ? ok({ items: {} })
      : ok({ imdb: "tt0111161", found: true, r: 4.6, n: 9, slug: "the-shawshank-redemption", reviews: [] })),
  });
  await second.helpers.letterboxdBatch(["tt0111161"]);
  assert.equal(second.calls.length, 0, "the next visit's grid must not ask again");

  // The watch page does not read that mark: opening the film fills the table.
  assert.equal((await second.helpers.letterboxdRating("tt0111161"))?.r, 4.6);
  assert.equal(second.calls.length, 1);
  assert.doesNotMatch(second.calls[0], /mode=batch/);
  // From then on every grid paints it.
  const card = fakeCard({ imdb: "tt0111161" });
  await second.helpers.fillGridLetterboxd(fakeGrid([card]));
  assert.match(card.painted[0] || "", /9\.2/);
  assert.equal(second.calls.length, 1);
});

test("the unknown mark lasts a day, then the grid asks again", async () => {
  const stale = new Map([[
    "alphy.cache.letterboxd.unknown.v1:tt0111161",
    JSON.stringify({ v: 1, exp: Date.now() - 1 }),
  ]]);
  const { helpers, calls } = await boot({ storageSeed: stale, handler: () => ok({ items: {} }) });
  await helpers.letterboxdBatch(["tt0111161"]);
  assert.equal(calls.length, 1);
});

test("a failed request cools the shard for minutes and is never remembered as unknown", async () => {
  const { helpers, calls, storage } = await boot({ handler: () => { throw new Error("project paused"); } });
  await helpers.letterboxdBatch(["tt0111161"]);
  assert.equal(calls.length, 1);
  assert.ok(![...storage.keys()].some((key) => key.includes("letterboxd.unknown")),
    "a failure says nothing about the film");
  await helpers.letterboxdBatch(["tt0111161"]);
  assert.equal(calls.length, 1, "the cooling shard is not asked again at once");
});

test("the snapshot's baked scores paint the home row with no request at all", async () => {
  const asked = [];
  const { helpers } = await boot({ handler: (url) => { asked.push(url); return ok({ items: {} }); } });
  const rated = fakeCard({ imdb: "tt0111161", lb: { r: 4.6, n: 3008699, slug: "the-shawshank-redemption" } });
  const none = fakeCard({ imdb: "tt0903747", lb: { r: 0 } });
  const broken = fakeCard({ imdb: "tt0137523", lb: { r: 9.1 } });
  const fresh = fakeCard({ imdb: "tt6751668" });
  await helpers.fillGridLetterboxd(fakeGrid([rated, none, broken, fresh]));

  assert.match(rated.painted[0] || "", /9\.2/);
  assert.equal(none.painted.length, 0, "a confirmed absence paints nothing");
  // Only the films the snapshot could not answer for reach the network — and a
  // malformed baked value counts as unanswered rather than as a score.
  assert.deepEqual(asked.flatMap(idsOf).sort(), ["tt0137523", "tt6751668"]);
});

test("a fully baked home page makes no Letterboxd call", async () => {
  const { helpers, calls } = await boot({ handler: () => ok({ items: {} }) });
  const rows = Array.from({ length: 12 }, (_, row) => fakeGrid(Array.from({ length: 8 }, (_, i) =>
    fakeCard({ imdb: `tt${4000000 + row * 8 + i}`, lb: { r: 3.5, n: 10, slug: "x" } }))));
  await Promise.all(rows.map((grid) => helpers.fillGridLetterboxd(grid)));
  await sleep(60);
  assert.equal(calls.length, 0);
});

test("the watch page asks once for its score and its reviews", async () => {
  const { helpers, calls, storage } = await boot({
    handler: () => ok({
      imdb: "tt0111161", found: true, r: 4.6, n: 5, slug: "the-shawshank-redemption",
      reviews: [{ a: "sam", r: 5, t: "great" }],
    }),
  });
  const [rating, reviews] = await Promise.all([
    helpers.letterboxdRating("tt0111161"),
    helpers.letterboxdReviews("tt0111161"),
  ]);
  assert.equal(rating?.r, 4.6);
  assert.equal(reviews?.length, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /reviews=1/);
  assert.ok(storage.has("alphy.cache.letterboxd.reviews.v1:tt0111161"));

  // Asked one after the other, the second is answered from what the first stored.
  assert.equal((await helpers.letterboxdReviews("tt0111161"))?.[0]?.t, "great");
  assert.equal(calls.length, 1);
});
