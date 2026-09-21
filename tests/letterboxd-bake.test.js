import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { makeSandbox, sleep } from "./helpers/app-sandbox.js";
import {
  LETTERBOXD_ENDPOINTS, endpointFor, imdbFor, cleanScore, bakeCatalog, network,
} from "../scripts/bake-curated-letterboxd.mjs";

// The home page's scores are baked into the published catalogue so a visit
// makes no Letterboxd call. These pin that the bake asks the same shards a
// browser would, never invents an id, and never drops a score it cannot refresh.

const catalogOf = (...items) => ({ schema: 1, revision: 1, lists: [{ id: "l", title: "L", items }] });

function fakeNetwork({ tables = {}, single = () => ({ unreachable: true }) } = {}) {
  const calls = { batch: [], single: [], sleeps: 0 };
  network.batch = async (endpoint, ids) => {
    calls.batch.push({ endpoint, ids });
    const table = tables[endpoint] || {};
    return Object.fromEntries(ids.filter((id) => id in table).map((id) => [id, table[id]]));
  };
  network.single = async (endpoint, id) => {
    calls.single.push({ endpoint, id });
    return single(id, endpoint);
  };
  network.sleep = async () => { calls.sleeps += 1; };
  return calls;
}

test("the bake asks the same shard the browser would for every film", async () => {
  const ctx = makeSandbox();
  ctx.run();
  await sleep(80);
  const app = ctx.sandbox.window.alphyBridge._test;
  assert.deepEqual(JSON.parse(JSON.stringify(app.LETTERBOXD_ENDPOINTS)), LETTERBOXD_ENDPOINTS);
  for (let n = 100000; n < 100400; n += 1) {
    assert.equal(endpointFor(`tt${n}0`), app.letterboxdEndpointOrder(`tt${n}0`)[0]);
  }
});

test("an id comes only from the film itself or the committed map", () => {
  const map = { "драйв|2011|f": { imdb: "tt0780504" }, "драйв|2011|s": { imdb: "tt9999999" } };
  assert.deepEqual(imdbFor({ title: "Что угодно", year: "2000", externalId: { imdb: "tt0111161" } }, map),
    { imdb: "tt0111161", carried: true });
  assert.deepEqual(imdbFor({ title: "Драйв", year: "2011" }, map), { imdb: "tt0780504", carried: false });
  // Letterboxd has no series, so a series is never matched by its title.
  assert.equal(imdbFor({ title: "Драйв", year: "2011", isSeries: true }, map).imdb, "");
  // Without a year a common title would bind to the wrong film.
  assert.equal(imdbFor({ title: "Драйв" }, map).imdb, "");
  assert.equal(imdbFor({ title: "Нет в карте", year: "2011" }, map).imdb, "");
});

test("only the fields a card shows are kept, and nonsense is not a score", () => {
  assert.deepEqual(cleanScore({ r: 4.6, n: 12, slug: "x", reviews: [1], extra: true }), { r: 4.6, n: 12, slug: "x" });
  assert.deepEqual(cleanScore(null), { r: 0 });
  for (const r of [0, -1, 9.1, "abc", undefined]) assert.equal(cleanScore({ r }), undefined);
});

test("known scores come from the tables; unknown films are looked up, capped and paced", async () => {
  const known = "tt0111161";
  const calls = fakeNetwork({
    tables: { [endpointFor(known)]: { [known]: { r: 4.6, n: 3, slug: "shawshank" } } },
    single: (id) => (id === "tt0903747"
      ? { imdb: id, found: false }
      : { imdb: id, found: true, r: 3.9, n: 7, slug: `s-${id}` }),
  });
  const catalog = catalogOf(
    { title: "A", year: "1994", externalId: { imdb: known } },
    { title: "B", year: "2008", isSeries: true, externalId: { imdb: "tt0903747" } },
    ...Array.from({ length: 5 }, (_, i) => ({ title: `C${i}`, year: "2010", externalId: { imdb: `tt500000${i}` } })),
  );
  const stats = await bakeCatalog(catalog, { maxLookups: 3 });
  const items = catalog.lists[0].items;
  assert.deepEqual(items[0].letterboxd, { r: 4.6, n: 3, slug: "shawshank" });
  assert.deepEqual(items[1].letterboxd, { r: 0 }, "a confirmed absence is baked too, so the grid never asks");
  assert.equal(calls.single.length, 3, "lookups are capped per run");
  assert.equal(calls.sleeps, 2, "and spaced apart");
  assert.ok(calls.batch.every(({ ids }) => ids.length <= 60));
  assert.equal(stats.unknown, 3, "what was not looked up this run stays unbaked, not zeroed");
  assert.ok(calls.single.every(({ endpoint, id }) => endpoint === endpointFor(id)));
});

test("a shard that cannot answer keeps the published score in place", async () => {
  fakeNetwork({ single: () => ({ unreachable: true }) });
  network.batch = async () => { throw new Error("paused"); };
  const previous = catalogOf({ title: "A", year: "1994", externalId: { imdb: "tt0111161" },
    letterboxd: { r: 4.6, n: 3, slug: "shawshank" } });
  const catalog = catalogOf({ title: "A", year: "1994", externalId: { imdb: "tt0111161" } });
  await bakeCatalog(catalog, { previous, maxLookups: 5 });
  assert.deepEqual(catalog.lists[0].items[0].letterboxd, { r: 4.6, n: 3, slug: "shawshank" });
});

test("an unchanged score keeps the published object, so the snapshot is not rewritten hourly", async () => {
  const id = "tt0111161";
  fakeNetwork({ tables: { [endpointFor(id)]: { [id]: { r: 4.6, n: 999, slug: "shawshank" } } } });
  const previous = catalogOf({ title: "A", year: "1994", externalId: { imdb: id },
    letterboxd: { r: 4.6, n: 3, slug: "shawshank" } });
  const catalog = catalogOf({ title: "A", year: "1994", externalId: { imdb: id } });
  await bakeCatalog(catalog, { previous });
  assert.equal(catalog.lists[0].items[0].letterboxd.n, 3, "only a moved score republishes");

  fakeNetwork({ tables: { [endpointFor(id)]: { [id]: { r: 4.55, n: 999, slug: "shawshank" } } } });
  const moved = catalogOf({ title: "A", year: "1994", externalId: { imdb: id } });
  await bakeCatalog(moved, { previous });
  assert.deepEqual(moved.lists[0].items[0].letterboxd, { r: 4.55, n: 999, slug: "shawshank" });
});

test("a film resolved through the map carries that id, so the browser needs no lookup either", async () => {
  fakeNetwork();
  const catalog = catalogOf({ title: "Драйв", year: "2011", externalId: { tmdb: "64690" } });
  await bakeCatalog(catalog, { mapEntries: { "драйв|2011|f": { imdb: "tt0780504" } }, maxLookups: 0 });
  assert.deepEqual(catalog.lists[0].items[0].externalId, { tmdb: "64690", imdb: "tt0780504" });
});

test("the catalogue CDN workflow runs the bake before it publishes", async () => {
  const workflow = await readFile(new URL("../.github/workflows/catalog-cdn.yml", import.meta.url), "utf8");
  const bake = workflow.indexOf("bake-curated-letterboxd.mjs");
  const publish = workflow.indexOf("git push origin HEAD:catalog-cdn");
  assert.ok(bake > 0 && publish > bake, "scores must be in the snapshot that is pushed");
  assert.match(workflow, /--previous/, "a failed lookup must be able to keep the published score");
});
