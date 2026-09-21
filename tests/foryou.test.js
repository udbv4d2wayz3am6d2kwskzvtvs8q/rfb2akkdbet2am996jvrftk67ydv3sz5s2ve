import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// foryou.js is a browser IIFE; evaluate it in a sandbox with stubbed
// window/localStorage/resolver bridge and drive the pure pipeline via exports.
async function loadForYou(storage = new Map(), fetchImpl = null) {
  const code = await readFile(new URL("../foryou.js", import.meta.url), "utf8");
  const localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
    key: (index) => [...storage.keys()][index] ?? null,
    get length() { return storage.size; },
  };
  const sandbox = {
    console,
    Date,
    JSON,
    Math,
    Promise,
    URL,
    URLSearchParams,
    crypto: globalThis.crypto,
    TextEncoder,
    setTimeout,
    clearTimeout,
    localStorage,
    fetch: fetchImpl || (async () => { throw new Error("network disabled in tests"); }),
    AbortController,
    CustomEvent: class CustomEvent {
      constructor(type, options) {
        this.type = type;
        this.detail = options?.detail;
      }
    },
    window: {
      addEventListener: () => {},
      dispatchEvent: () => {},
      alphyBridge: { resolverJson: async () => { throw new Error("network disabled in tests"); } },
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return { api: sandbox.window.alphyForYou, storage, sandbox };
}

test("shared failure never downloads or spends browser keys", async () => {
  const calls = [];
  const { api } = await loadForYou(new Map(), async (url) => { calls.push(String(url)); return new Response("{}", { status: 503 }); });
  await assert.rejects(api._test.directUnofficialGet("/api/v2.2/films/301"), { code: "shared_unavailable" });
  assert.ok(calls.every((url) => url.includes("supabase.co/storage/")));
});

test("keyword results share the broker hash and bypass Deno on a Storage hit", async () => {
  const { objectPath, objectSlot, hostFor } = await import("../supabase/functions/kp/index.ts");
  const query = "матрица фильм";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(query));
  const id = parseInt(Buffer.from(digest).subarray(0, 6).toString("hex"), 16) + 1;
  const expected = `https://${hostFor(id)}.supabase.co/storage/v1/object/public/kp/${objectPath("search", id, objectSlot("search", id))}`;
  const calls = [];
  const { api, sandbox } = await loadForYou(new Map(), async (url) => {
    calls.push(String(url));
    assert.equal(String(url), expected);
    return new Response(JSON.stringify({ v: 1, kind: "search", id, query, status: "ok",
      freshUntil: new Date(Date.now() + 60000).toISOString(), data: { films: [{ filmId: 301 }] } }));
  });
  sandbox.window.alphyBridge.resolverJson = async () => { assert.fail("a query cache hit must not invoke Deno"); };
  const data = await api._test.directUnofficialGet(`/api/v2.1/films/search-by-keyword?keyword=${encodeURIComponent("  МАТРИЦА   фильм  ")}&page=1`);
  assert.equal(data.films[0].filmId, 301);
  assert.ok(data.__alphyFreshUntil > Date.now());
  assert.equal(Object.keys(data).includes("__alphyFreshUntil"), false);
  assert.equal(calls.length, 1);
});

function historyEntry(overrides = {}) {
  return {
    key: `kp:${overrides.kpId || "1"}`,
    kind: "kp",
    target: { kind: "kp", kpId: overrides.kpId || "1" },
    title: "Фильм",
    progress: 1,
    updatedAt: Date.now(),
    ...overrides,
  };
}

test("buildSeeds: weights favour finished + recent, zen entries go to unresolved", async () => {
  const storage = new Map();
  const now = Date.now();
  storage.set("alphy.history", JSON.stringify([
    historyEntry({ kpId: "100", title: "Свежий досмотренный", progress: 0.95, updatedAt: now }),
    historyEntry({ kpId: "200", title: "Старый брошенный", progress: 0.05, updatedAt: now - 120 * 86400e3 }),
    {
      key: "zen:555", kind: "zen", target: { kind: "zen", zenithId: "555" },
      title: "Зенитный без кп", progress: 0.9, updatedAt: now,
    },
  ]));
  storage.set("alphy.bookmarks", JSON.stringify([
    {
      key: "kp:300", kind: "kp", target: { kind: "kp", kpId: "300" },
      title: "Из закладок", addedAt: now,
    },
  ]));

  const { api } = await loadForYou(storage);
  const { seeds, unresolved, excludeKp, excludeTitles } = api._test.buildSeeds();

  const byId = Object.fromEntries(seeds.map((seed) => [seed.kpId, seed]));
  assert.ok(byId["100"], "finished recent film is a seed");
  assert.ok(byId["100"].weight > byId["200"].weight * 3, "recency+engagement dominate");
  assert.ok(byId["300"], "bookmark-only entry becomes a seed");
  assert.ok(byId["300"].weight < byId["100"].weight, "bookmark weighs less than a finished watch");
  assert.equal(unresolved.length, 1, "zen entry waits for kpId backfill");
  assert.ok(excludeKp.has("100") && excludeKp.has("300"));
  assert.ok(excludeTitles.has(api._test.normTitle("Зенитный без кп")), "watched titles excluded even without kpId");
});

test("buildSeeds: an accidental open is excluded but a zero-second bookmark remains a seed", async () => {
  const now = Date.now();
  const storage = new Map([
    ["alphy.history", JSON.stringify([
      historyEntry({ key: "kp:10", kpId: "10", title: "Только открыл", progress: 0, position: 0, updatedAt: now }),
      historyEntry({ key: "kp:20", kpId: "20", title: "Сохранил", progress: 0, position: 0, updatedAt: now }),
    ])],
    ["alphy.bookmarks", JSON.stringify([
      { key: "kp:20", target: { kind: "kp", kpId: "20" }, title: "Сохранил", addedAt: now },
    ])],
  ]);
  const { api } = await loadForYou(storage);
  const { seeds, excludeKp } = api._test.buildSeeds();
  assert.deepEqual(Array.from(seeds, (seed) => String(seed.kpId)), ["20"]);
  assert.ok(excludeKp.has("10"), "an opened title is still excluded from recommendations");
});

test("scoreCandidates: intersection beats a single top position", async () => {
  const { api } = await loadForYou();
  const seedA = { kpId: "1", weight: 1 };
  const seedB = { kpId: "2", weight: 1 };
  const picked = api._test.scoreCandidates([
    { seed: seedA, similars: [{ id: "10", ru: "Уникум" }, { id: "20", ru: "Пересечение" }] },
    { seed: seedB, similars: [{ id: "20", ru: "Пересечение" }] },
  ], new Set(), new Set());

  assert.equal(picked[0].id, "20", "candidate named by two seeds ranks first");
  assert.equal(picked[0].hits, 2);
  assert.ok(picked[0].final > picked[1].final);
});

test("scoreCandidates: a generic tail intersection cannot bury a strong first choice", async () => {
  const { api } = await loadForYou();
  const tail = Array.from({ length: 20 }, (_, index) => ({ id: `a${index}`, ru: `A ${index}` }));
  tail[19] = { id: "999", ru: "Общий хвост" };
  const picked = api._test.scoreCandidates([
    { seed: { kpId: "1", weight: 1 }, similars: [{ id: "100", ru: "Сильный первый" }, ...tail] },
    { seed: { kpId: "2", weight: 0.8 }, similars: [...Array.from({ length: 19 }, (_, i) => ({ id: `b${i}`, ru: `B ${i}` })), { id: "999", ru: "Общий хвост" }] },
  ], new Set(), new Set());
  assert.equal(picked[0].id, "100");
});

test("scoreCandidates: excludes watched kpIds and watched titles", async () => {
  const { api } = await loadForYou();
  const seed = { kpId: "1", weight: 1 };
  const picked = api._test.scoreCandidates(
    [{ seed, similars: [
      { id: "10", ru: "Уже смотрел" },
      { id: "20", ru: "Новое" },
      { id: "30", ru: "Смотрел под другим айди" },
    ] }],
    new Set(["10"]),
    new Set([api._test.normTitle("Смотрел под другим айди")]),
  );
  assert.deepEqual(JSON.parse(JSON.stringify(picked.map((p) => p.id))), ["20"]);
});

test("scoreCandidates: one seed can fill a useful row but not own all 18 slots", async () => {
  const { api } = await loadForYou();
  const hot = { kpId: "1", weight: 10 };
  const other = { kpId: "2", weight: 0.2 };
  const hotSimilars = Array.from({ length: 12 }, (_, i) => ({ id: `h${i}`, ru: `Хит ${i}` }));
  const picked = api._test.scoreCandidates([
    { seed: hot, similars: hotSimilars },
    { seed: other, similars: [{ id: "o1", ru: "Тихий" }] },
  ], new Set(), new Set());
  const fromHot = picked.filter((p) => p.primarySeed === "1").length;
  assert.ok(fromHot <= 7, `diversity cap holds (got ${fromHot})`);
  assert.ok(picked.some((p) => p.id === "o1"), "weak seed still contributes");
});

test("toCuratedItem: produces a playable curated-shaped card", async () => {
  const { api } = await loadForYou();
  const item = api._test.toCuratedItem(
    { id: "301", ru: "Матрица", orig: "The Matrix", poster: "https://kinopoiskapiunofficial.tech/images/posters/kp/301.jpg" },
    { year: "1999", isSeries: false, rating: { kp: 8.5, imdb: 8.7 }, movieLength: 136 },
  );
  assert.equal(item.key, "kp:301");
  assert.deepEqual(JSON.parse(JSON.stringify(item.target)), { kind: "kp", kpId: "301" });
  assert.equal(item.title, "Матрица");
  assert.equal(item.year, "1999");
  assert.equal(item.movieLength, 136);
});

test("hide removes a title from the row, persists, and stays hidden after reload", async () => {
  const storage = new Map();
  storage.set("alphy.foryou.last.v1", JSON.stringify({
    items: Array.from({ length: 8 }, (_, i) => ({ id: `fy-${i}`, key: `kp:${i}`, title: `t${i}`, target: { kind: "kp", kpId: String(i) } })),
    at: Date.now(),
  }));
  const { api } = await loadForYou(storage);
  assert.equal(api.getItems().length, 8);
  api.hide("3");
  assert.equal(api.getItems().length, 7);
  assert.ok(!api.getItems().some((item) => item.target.kpId === "3"), "hidden item gone from the row");
  assert.ok(api._test.hiddenIds().has("3"), "dismissal persisted");
  // A fresh session with the same storage keeps it hidden (cached row included).
  const second = await loadForYou(storage);
  assert.ok(!second.api.getItems().some((item) => item.target.kpId === "3"));
  // Hiding is not a taste signal: seeds/history are untouched.
  assert.equal(storage.has("alphy.history"), false);
});

test("hidden ids are excluded from future scoring but do not touch seeds", async () => {
  const storage = new Map();
  storage.set("alphy.foryou.hidden.v1", JSON.stringify([{ id: "20", at: Date.now() }]));
  const { api } = await loadForYou(storage);
  const seed = { kpId: "1", weight: 1 };
  // compute() merges hiddenIds into excludeKp; emulate that contract here.
  const exclude = new Set(api._test.hiddenIds());
  const picked = api._test.scoreCandidates(
    [{ seed, similars: [{ id: "10", ru: "Оставить" }, { id: "20", ru: "Скрытое" }] }],
    exclude,
    new Set(),
  );
  assert.deepEqual(JSON.parse(JSON.stringify(picked.map((p) => p.id))), ["10"]);
});

test("cached row paints instantly; mode off empties it", async () => {
  const storage = new Map();
  storage.set("alphy.foryou.last.v1", JSON.stringify({
    items: Array.from({ length: 7 }, (_, i) => ({ id: `fy-${i}`, key: `kp:${i}`, title: `t${i}`, target: { kind: "kp", kpId: String(i) } })),
    at: Date.now(),
  }));
  const { api } = await loadForYou(storage);
  assert.equal(api.getItems().length, 7, "last row paints instantly before mode arrives");
  api.setMode("off");
  assert.equal(api.getItems().length, 0, "off hides the row everywhere");
});

test("one strong seed publishes a useful row instead of hiding five valid titles", async () => {
  const storage = new Map();
  const now = Date.now();
  storage.set("alphy.history", JSON.stringify([
    historyEntry({ kpId: "100", title: "Любимое", progress: 0.95, updatedAt: now }),
  ]));
  storage.set("alphy.bookmarks", JSON.stringify([]));
  storage.set("alphy.foryou.sim.100", JSON.stringify({
    v: Array.from({ length: 7 }, (_, i) => ({ id: String(200 + i), ru: `Фильм ${i}` })),
    exp: now + 86400e3,
  }));

  const { api } = await loadForYou(storage);
  api.setMode("frozen");
  await api.refresh();
  assert.equal(api.getItems().length, 7);
});

// --- «Похожее» -------------------------------------------------------------

test("rankSimilars: keeps the title's own pool but promotes what the viewer likes", async () => {
  const storage = new Map();
  const now = Date.now();
  // The viewer finished film 100. Its cached similars name candidate 30.
  storage.set("alphy.history", JSON.stringify([
    historyEntry({ kpId: "100", title: "Любимое", progress: 0.95, updatedAt: now }),
  ]));
  storage.set("alphy.bookmarks", JSON.stringify([]));
  storage.set("alphy.foryou.sim.100", JSON.stringify({
    v: [{ id: "30", ru: "Связанное со вкусом" }],
    exp: now + 86400e3,
  }));

  const { api } = await loadForYou(storage);
  // Pool for the title being watched (id 900): 30 sits LAST by Kinopoisk order.
  const picked = api._test.rankSimilars([
    { id: "10", ru: "Первое" },
    { id: "20", ru: "Второе" },
    { id: "30", ru: "Связанное со вкусом" },
  ], "900");

  assert.equal(picked[0].id, "30", "taste affinity outranks raw Kinopoisk position");
  assert.deepEqual(picked.map((p) => p.id).sort(), ["10", "20", "30"], "pool is not widened");
  assert.ok(picked.every((p) => p.score > 0));
});

test("rankSimilars: never recommends the current title, watched titles or hidden ones", async () => {
  const storage = new Map();
  const now = Date.now();
  storage.set("alphy.history", JSON.stringify([
    historyEntry({ kpId: "10", title: "Уже смотрел", updatedAt: now }),
    { key: "zen:7", kind: "zen", target: { kind: "zen", zenithId: "7" }, title: "Только по названию", updatedAt: now },
  ]));
  storage.set("alphy.bookmarks", JSON.stringify([]));
  storage.set("alphy.foryou.hidden.v1", JSON.stringify([{ id: "20", at: now }]));

  const { api } = await loadForYou(storage);
  const picked = api._test.rankSimilars([
    { id: "10", ru: "Уже смотрел" },
    { id: "20", ru: "Скрытое" },
    { id: "30", ru: "Только по названию" },
    { id: "900", ru: "Сам этот фильм" },
    { id: "40", ru: "Годное" },
  ], "900");

  assert.deepEqual(picked.map((p) => p.id), ["40"]);
});

test("affinityIndex reads only cached similars and ignores the current title's own seed", async () => {
  const storage = new Map();
  const now = Date.now();
  storage.set("alphy.history", JSON.stringify([
    historyEntry({ kpId: "100", title: "Одно", updatedAt: now }),
    historyEntry({ kpId: "200", title: "Другое", updatedAt: now }),
  ]));
  storage.set("alphy.bookmarks", JSON.stringify([]));
  storage.set("alphy.foryou.sim.100", JSON.stringify({ v: [{ id: "5", ru: "A" }], exp: now + 86400e3 }));
  // 200 has no cached similars: it must be skipped silently, never fetched
  // (the sandbox's fetch throws, so a fetch here would fail the test).
  const { api } = await loadForYou(storage);

  const all = api._test.affinityIndex("");
  assert.ok(all.affinity.get("5") > 0);

  const excluded = api._test.affinityIndex("100");
  assert.equal(excluded.affinity.size, 0, "the title being watched does not vote for its own similars");
});

test("similar metadata shares film objects with watch pages and then stays local", async () => {
  const now = Date.now();
  const storage = new Map();
  storage.set("alphy.foryou.sim.900", JSON.stringify({
    v: ["10", "20", "30", "40"].map((id) => ({ id, ru: `Фильм ${id}`, poster: `https://p/${id}.jpg` })),
    exp: now + 86400e3,
  }));
  const { api, sandbox } = await loadForYou(storage);
  const calls = [];
  sandbox.window.alphyBridge.resolverJson = async (path) => {
    calls.push(path);
    const id = new URL(path, "https://x").searchParams.get("id");
    const index = ["10", "20", "30", "40"].indexOf(id);
    return { v: 1, kind: "film", id: Number(id), status: "ok", data: {
      kinopoiskId: Number(id), year: 2000 + index, isSeries: false, movieLength: 100 + index,
      rating: { kp: 7 + index / 10, imdb: 6 + index / 10 }, poster: `https://resolved/${id}.jpg`,
    }};
  };
  api.setMode("on");

  const initial = await api.similarRow("900");
  assert.equal(initial[0].year, "", "similars paint before enrichment");
  const enriched = await api.enrichSimilarRow("900");
  assert.equal(calls.length, 4);
  assert.ok(calls.every((path) => path.startsWith("/kp?kind=film&id=")));
  assert.equal(enriched[0].year, "2000");
  assert.ok(enriched[0].rating.kp > 0);

  await api.enrichSimilarRow("900");
  assert.equal(calls.length, 4, "the second render is cache-only");
});

test("personNames pulls directors and cast out of the staff payload in order", async () => {
  const { api } = await loadForYou();
  const staff = [
    { professionKey: "DIRECTOR", nameRu: "Режиссёр" },
    { professionKey: "ACTOR", nameRu: "Первый" },
    { professionKey: "ACTOR", nameRu: "Второй" },
    { professionKey: "ACTOR", nameRu: "Первый" },
    { professionKey: "WRITER", nameRu: "Сценарист" },
    { professionKey: "ACTOR", nameEn: "Third" },
  ];
  // The sandbox returns cross-realm arrays, so compare plain structures.
  const names = (...args) => JSON.parse(JSON.stringify(api._test.personNames(...args)));
  assert.deepEqual(names(staff, "DIRECTOR", 3), ["Режиссёр"]);
  assert.deepEqual(names(staff, "ACTOR", 2), ["Первый", "Второй"], "deduped and capped");
  assert.deepEqual(names(staff, "ACTOR", 9), ["Первый", "Второй", "Third"]);
  assert.deepEqual(names(null, "ACTOR", 3), []);
});

// --- key rotation ----------------------------------------------------------
// The key pool is made of free kinopoiskapiunofficial accounts, and those get
// deactivated in batches. A deactivated key answers 403 with
// "User <mail> is inactive or deleted" — verified live against ten such keys.
// That is a rotate-and-continue condition, not a fatal error.

test("film extras use resolver routes and preserve Kinopoisk person ids", async () => {
  const { api, sandbox } = await loadForYou();
  const seen = [];
  sandbox.window.alphyBridge.resolverJson = async (path) => {
    seen.push(path);
    if (path === "/kp?kind=film&id=326") {
      return { v: 1, kind: "film", id: 326, status: "ok", data: {
        genres: [{ genre: "\u0434\u0440\u0430\u043c\u0430" }],
        countries: [{ country: "\u0421\u0428\u0410" }],
        ratingAgeLimits: "age16",
      }};
    }
    if (path === "/kp?kind=staff&id=326") {
      return { v: 1, kind: "staff", id: 326, status: "ok", data: [
        { staffId: 42, nameRu: "\u0420\u0435\u0436\u0438\u0441\u0441\u0451\u0440", professionKey: "DIRECTOR" },
        { staffId: 77, nameRu: "\u0410\u043a\u0442\u0451\u0440", professionKey: "ACTOR" },
      ]};
    }
    throw new Error(`unexpected path ${path}`);
  };
  api.setMode("on");

  const extras = await api.filmExtras("326");
  assert.ok(extras);
  assert.equal(JSON.parse(JSON.stringify(extras.genres))[0], "\u0434\u0440\u0430\u043c\u0430");
  assert.equal(extras.ageRating, 16);
  assert.deepEqual(JSON.parse(JSON.stringify(extras.people.directors)), [
    { id: "42", name: "\u0420\u0435\u0436\u0438\u0441\u0441\u0451\u0440" },
  ]);
  assert.deepEqual(new Set(seen), new Set([
    "/kp?kind=film&id=326",
    "/kp?kind=staff&id=326",
  ]));
});

test("resolver failure fails extras softly without breaking the watch page", async () => {
  const { api, sandbox } = await loadForYou();
  let calls = 0;
  sandbox.window.alphyBridge.resolverJson = async () => {
    calls += 1;
    throw new Error("recommendation pool exhausted");
  };
  api.setMode("on");

  const extras = await api.filmExtras("326");
  assert.equal(extras, null);
  assert.equal(calls, 2, "film and staff fail independently but softly");
});

test("new visitors never fetch the Vercel key pool for metadata", async () => {
  const calls = [];
  const { api, sandbox } = await loadForYou(new Map(), async (url) => { calls.push(String(url)); return new Response("{}", { status: 404 }); });
  sandbox.window.alphyBridge.resolverJson = async (path) => ({ v: 1, kind: "film", id: 301, status: "ok", freshUntil: new Date(Date.now()+3600000).toISOString(), data: { kinopoiskId: 301 } });
  const film = await api._test.directUnofficialGet("/api/v2.2/films/301");
  assert.equal(film.kinopoiskId, 301);
  assert.ok(calls.every((url) => !url.includes("client-key-pool") && !url.includes("kinopoiskapiunofficial")));
});
