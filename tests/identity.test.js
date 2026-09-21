// Identity resolution must never reach a metered API, and must never guess.
//
// The second rule is the one with teeth: attaching a wrong IMDb id shows a
// confident, wrong score next to the right poster, which is worse than showing
// nothing. Every test below is about refusing rather than resolving.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SOURCE = readFileSync(new URL("../identity.js", import.meta.url), "utf8");
const MAP = JSON.parse(readFileSync(new URL("../imdb-map.json", import.meta.url), "utf8"));

function boot({ handler = () => { throw new Error("сеть не ожидалась"); }, map = MAP } = {}) {
  const store = new Map();
  const calls = [];
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    get length() { return store.size; },
    key: (i) => [...store.keys()][i],
  };
  // Object.keys(localStorage) is how the eviction path enumerates; a plain
  // object with the entries mirrored onto it is the honest stand-in.
  const lsProxy = new Proxy(localStorage, {
    ownKeys: () => [...store.keys()],
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
  });

  const window = {};
  const context = {
    window,
    localStorage: lsProxy,
    AbortSignal: { timeout: () => undefined },
    console,
    fetch: async (url) => {
      calls.push(String(url));
      if (String(url).includes("/imdb-map.json")) {
        return { ok: true, json: async () => map };
      }
      return handler(String(url));
    },
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(SOURCE, context);
  return { identity: window.alphyIdentity, calls, store };
}

const ok = (metas) => ({ ok: true, json: async () => ({ metas }) });

test("an id the payload already carries is trusted and costs nothing", async () => {
  const { identity, calls } = boot();
  assert.equal(await identity.resolve({ imdb: "tt0816692", title: "Интерстеллар", year: 2014 }), "tt0816692");
  assert.deepEqual(calls, [], "nothing should have been fetched");
});

test("nested provider identity is trusted and normalized without a lookup", async () => {
  const { identity, calls } = boot();
  assert.equal(await identity.resolve({ externalId: { imdb: "TT0816692" } }), "tt0816692");
  assert.deepEqual(calls, []);
});

test("the committed catalogue resolves without touching the network", async () => {
  const { identity, calls } = boot();
  // Built by scripts/build-imdb-map.mjs; "Большой куш" is Snatch (2000).
  assert.equal(await identity.resolve({ title: "Большой куш", year: 2000 }), "tt0208092");
  assert.deepEqual(calls.filter((u) => u.includes("cinemeta")), []);
});

test("a title outside the catalogue goes to Cinemeta, once, then to cache", async () => {
  let hits = 0;
  const { identity } = boot({
    handler: () => { hits += 1; return ok([{ name: "Inception", releaseInfo: "2010", imdb_id: "tt1375666" }]); },
  });
  assert.equal(await identity.resolve({ title: "Начало", year: 2010 }), "tt1375666");
  assert.equal(await identity.resolve({ title: "Начало", year: 2010 }), "tt1375666");
  assert.equal(hits, 1);
});

test("a year that does not match is refused rather than guessed", async () => {
  // Cinemeta ranks by popularity, so a bare title query returns the famous film
  // regardless of which one was asked for. This is the guard that matters.
  const { identity } = boot({
    handler: () => ok([{ name: "Drive", releaseInfo: "2011", imdb_id: "tt0780504" }]),
  });
  assert.equal(await identity.resolve({ title: "Драйв", year: 1997 }), "",
    "a 1997 film must not inherit the 2011 film's id");
});

test("a title with no year is never resolved", async () => {
  const { identity, calls } = boot({
    handler: () => ok([{ name: "Drive", releaseInfo: "2011", imdb_id: "tt0780504" }]),
  });
  assert.equal(await identity.resolve({ title: "Драйв", year: "" }), "");
  assert.deepEqual(calls.filter((u) => u.includes("cinemeta")), [],
    "without a year there is nothing to verify against, so do not even ask");
});

test("a release a year off is accepted", async () => {
  // "Стрингер" is filed as 2013 by our sources and 2014 by Cinemeta; both mean
  // Nightcrawler. Refusing this would lose real films to a calendar quibble.
  const { identity } = boot({
    handler: () => ok([{ name: "Nightcrawler", releaseInfo: "2014", imdb_id: "tt2872718" }]),
  });
  assert.equal(await identity.resolve({ title: "Стрингер", year: 2013 }), "tt2872718");
});

test("a miss is remembered, so a grid does not re-ask on every render", async () => {
  let hits = 0;
  const { identity } = boot({ handler: () => { hits += 1; return ok([]); } });
  assert.equal(await identity.resolve({ title: "Неизвестное кино", year: 1999 }), "");
  assert.equal(await identity.resolve({ title: "Неизвестное кино", year: 1999 }), "");
  assert.equal(hits, 1);
});

test("an unreachable Cinemeta is not recorded as a verdict about the film", async () => {
  let attempt = 0;
  const { identity } = boot({
    handler: () => {
      attempt += 1;
      if (attempt === 1) throw new Error("сеть отвалилась");
      return ok([{ name: "Inception", releaseInfo: "2010", imdb_id: "tt1375666" }]);
    },
  });
  assert.equal(await identity.resolve({ title: "Начало", year: 2010 }), "");
  assert.equal(await identity.resolve({ title: "Начало", year: 2010 }), "tt1375666",
    "a network blip must not blacklist the title for three days");
});

test("a series is asked of the series catalogue, not the film one", async () => {
  const seen = [];
  const { identity } = boot({
    handler: (url) => { seen.push(url); return ok([{ name: "Andor", releaseInfo: "2099", imdb_id: "tt9253284" }]); },
  });
  await identity.resolve({ title: "Некий сериал", year: 2099, isSeries: true });
  assert.ok(seen[0].includes("/series/"), seen[0]);
});

test("an original title is preferred, and the Russian one is the fallback", async () => {
  const seen = [];
  const { identity } = boot({
    handler: (url) => {
      seen.push(decodeURIComponent(url));
      // Cinemeta does not know this transliteration, but knows the alias.
      return seen.length === 1 ? ok([]) : ok([{ name: "Hardcore Henry", releaseInfo: "2015", imdb_id: "tt3072482" }]);
    },
  });
  const id = await identity.resolve({ title: "Хардкор", originalTitle: "Hardkor", year: 2015 });
  assert.equal(id, "tt3072482");
  assert.ok(seen[0].includes("Hardkor"), "the original title is tried first");
  assert.ok(seen[1].includes("Хардкор"), "then the title we display");
});

test("two callers racing the same title share one request", async () => {
  let hits = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { identity } = boot({
    handler: async () => {
      hits += 1;
      await gate;
      return ok([{ name: "Inception", releaseInfo: "2010", imdb_id: "tt1375666" }]);
    },
  });
  const both = Promise.all([
    identity.resolve({ title: "Начало", year: 2010 }),
    identity.resolve({ title: "Начало", year: 2010 }),
  ]);
  release();
  assert.deepEqual(await both, ["tt1375666", "tt1375666"]);
  assert.equal(hits, 1);
});

test("no path leads to the metered API", async () => {
  const { identity, calls } = boot({ handler: () => ok([]) });
  await identity.resolve({ title: "Что угодно", year: 2001 });
  await identity.resolveMany([{ title: "Ещё что-то", year: 2002 }]);
  const metered = calls.filter((u) => /poiskkino|kinopoisk|deno\.net/i.test(u));
  assert.deepEqual(metered, [], `identity must stay free of quota: ${metered}`);
});

test("the committed map covers the whole catalogue it was built from", () => {
  const catalogue = JSON.parse(readFileSync(new URL("../curated-fallback.json", import.meta.url), "utf8"));
  const items = (catalogue.lists ?? []).flatMap((list) => list.items ?? []);
  const { identity } = boot();
  const missing = items.filter((item) => {
    const key = identity._test.mapKey(item.title, String(item.year).slice(0, 4), !!item.isSeries);
    return !MAP.entries[key];
  });
  assert.deepEqual(missing.map((i) => `${i.title} (${i.year})`), [],
    "run: node scripts/build-imdb-map.mjs");
});

test("a film and series with the same title and year cannot poison each other's identity", async () => {
  const { identity, store } = boot({
    map: { entries: {} },
    handler: (url) => ok([{
      name: url.includes("/series/") ? "Shared Series" : "Shared Film",
      releaseInfo: "2020",
      imdb_id: url.includes("/series/") ? "tt2222222" : "tt1111111",
    }]),
  });
  assert.equal(await identity.resolve({ title: "Одинаковое", year: 2020, isSeries: false }), "tt1111111");
  assert.equal(await identity.resolve({ title: "Одинаковое", year: 2020, isSeries: true }), "tt2222222");
  assert.ok([...store.keys()].some((key) => key.endsWith("|f")));
  assert.ok([...store.keys()].some((key) => key.endsWith("|s")));
});
