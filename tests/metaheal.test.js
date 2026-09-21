import test from "node:test";
import assert from "node:assert/strict";
import { makeSandbox, sleep, CATALOG, EMBED, ORT_KEY } from "./helpers/app-sandbox.js";

// Runs the real app.js (via the shared vm harness) and verifies the watch-page
// meta pipeline for kinds that carry no kpId (Ortified/Opravar):
//   1. a rotted (bare) ort history entry heals from the published curated catalog
//   2. onOrtProgress cannot clobber stored rating/movieLength/title
//   3. openCuratedItem's meta handoff survives localStorage quota exhaustion


test("rotted ort history entry heals from the curated catalog", async () => {
  const seed = new Map();
  seed.set("alphy.history", JSON.stringify([{
    key: ORT_KEY, kind: "ort", target: { kind: "ort", embedUrl: EMBED },
    title: "", poster: "", year: "", progress: 0.3, position: 300, duration: 1000, updatedAt: Date.now() - 86400e3,
  }]));
  const ctx = makeSandbox({ storageSeed: seed, startPath: "/o/88776" });
  ctx.run();
  await sleep(400);
  const hist = JSON.parse(ctx.storage.get("alphy.history") || "[]");
  const entry = hist.find((h) => h.key === ORT_KEY);
  assert.equal(entry?.title, "Обсессия", "title healed from catalog");
  assert.ok(entry?.poster, "poster healed");
  assert.equal(entry?.year, "2025");
  assert.ok(entry?.progress > 0.2, "progress preserved through the heal");
  const ortmetaRaw = ctx.storage.get(`alphy.cache.ortmeta:${EMBED}`);
  const ortmeta = ortmetaRaw ? JSON.parse(ortmetaRaw).v : null;
  assert.ok(ortmeta?.description && ortmeta?.rating?.kp, "ortmeta cache refreshed with description+rating");
});

test("ort progress reports cannot clobber stored meta", async () => {
  const seed = new Map();
  seed.set("alphy.history", JSON.stringify([{
    key: ORT_KEY, kind: "ort", target: { kind: "ort", embedUrl: EMBED },
    title: "Обсессия", poster: "https://p/x.webp", year: "2025",
    rating: { kp: 7.251, imdb: 8.1 }, movieLength: 109,
    progress: 0.3, position: 300, duration: 1000, updatedAt: Date.now() - 86400e3,
  }]));
  // Empty catalog: nothing to heal from, currentMeta arrives with rating {} —
  // the exact setup that used to wipe stored ratings on every progress tick.
  const ctx = makeSandbox({ storageSeed: seed, startPath: "/o/88776", catalog: { schema: 1, revision: 1, lists: [] } });
  ctx.run();
  await sleep(300);
  const handlers = ctx.listeners.window.message || [];
  assert.ok(handlers.length, "message handlers registered");
  for (const fn of handlers) {
    try { fn({ data: { alphyOrtProgress: true, position: 500, duration: 1000 }, origin: "https://api.ortified.ws" }); } catch { /* other listeners */ }
  }
  await sleep(50);
  const hist = JSON.parse(ctx.storage.get("alphy.history") || "[]");
  const entry = hist.find((h) => h.key === ORT_KEY);
  assert.equal(entry?.title, "Обсессия");
  assert.equal(entry?.rating?.kp, 7.251, "rating survives a bare progress tick");
  assert.equal(entry?.movieLength, 109);
  assert.equal(entry?.progress, 0.5, "progress itself is recorded");
});

// Real catalog series keys look like ?season=1&episode=1&episode=1 (duplicated
// param from the admin add flow) while the router rebuilds a clean query — the
// mismatch left every ort series bare even right after a curated click.
const SERIES_EMBED_DIRTY = "https://api.ortified.ws/embed/movie/73418?season=1&episode=1&episode=1";
const SERIES_EMBED_CLEAN = "https://api.ortified.ws/embed/movie/73418?season=1&episode=1";
const SERIES_CATALOG = {
  schema: 1, revision: 244, lists: [{ id: "l1", title: "Анимация", items: [{
    id: "x2", key: `ort:${SERIES_EMBED_DIRTY}`, title: "Задорные друзья", year: "2020",
    poster: "https://static.cdnlbox.club/poster/web/smiling.webp",
    description: "Пим и Чарли поднимают людям настроение.",
    isSeries: true, rating: { kp: 8.2, imdb: 8.5 },
    target: { kind: "ort", embedUrl: SERIES_EMBED_DIRTY },
  }] }],
};

test("ort series heals despite duplicated query params in the catalog key", async () => {
  // Cold private-mode start: empty localStorage, deep link to a series episode.
  const ctx = makeSandbox({ startPath: "/o/73418/s1e1", catalog: SERIES_CATALOG });
  ctx.run();
  await sleep(400);
  const hist = JSON.parse(ctx.storage.get("alphy.history") || "[]");
  const entry = hist.find((h) => h.key === `ort:${SERIES_EMBED_CLEAN}`);
  assert.equal(entry?.title, "Задорные друзья", "series title healed via base-URL key match");
  assert.ok(entry?.poster, "series poster healed");
  const ortmetaRaw = ctx.storage.get(`alphy.cache.ortmeta:${SERIES_EMBED_CLEAN}`);
  const ortmeta = ortmetaRaw ? JSON.parse(ortmetaRaw).v : null;
  assert.ok(ortmeta?.rating?.kp, "ortmeta cached under the clean URL the router uses");
});

test("curated series click hands meta to the watch page under the clean URL", async () => {
  const ctx = makeSandbox({ catalog: SERIES_CATALOG });
  ctx.run();
  await sleep(150);
  ctx.sandbox.window.alphyBridge.openCuratedItem(SERIES_CATALOG.lists[0].items[0]);
  await sleep(300);
  const ortmetaRaw = ctx.storage.get(`alphy.cache.ortmeta:${SERIES_EMBED_CLEAN}`);
  const ortmeta = ortmetaRaw ? JSON.parse(ortmetaRaw).v : null;
  assert.equal(ortmeta?.title, "Задорные друзья", "handoff keyed by the router's clean URL");
  const hist = JSON.parse(ctx.storage.get("alphy.history") || "[]");
  const entry = hist.find((h) => h.key === `ort:${SERIES_EMBED_CLEAN}`);
  assert.equal(entry?.title, "Задорные друзья", "history entry created with the curated title");
});

test("boot sweep drops expired foryou caches but never its stateful keys", async () => {
  const now = Date.now();
  const seed = new Map();
  seed.set("alphy.foryou.sim.111", JSON.stringify({ v: [{ id: "1", ru: "Старое" }], exp: now - 1000 }));
  seed.set("alphy.foryou.sim.222", JSON.stringify({ v: [{ id: "2", ru: "Свежее" }], exp: now + 86400e3 }));
  seed.set("alphy.foryou.quota.2026-07-09", "14");
  seed.set("alphy.foryou.hidden.v1", JSON.stringify([{ id: "3", at: now }]));
  seed.set("alphy.foryou.last.v1", JSON.stringify({ items: [], at: now }));
  seed.set("alphy.cache.zona:42", JSON.stringify({ v: { embedUrl: "x" }, exp: now - 1000 }));
  const ctx = makeSandbox({ storageSeed: seed });
  ctx.run();
  await sleep(100);
  assert.equal(ctx.storage.has("alphy.foryou.sim.111"), false, "expired sim swept at boot");
  assert.equal(ctx.storage.has("alphy.cache.zona:42"), false, "expired app cache swept at boot");
  assert.ok(ctx.storage.has("alphy.foryou.sim.222"), "live sim kept");
  assert.equal(ctx.storage.get("alphy.foryou.quota.2026-07-09"), "14", "quota counter untouched");
  assert.ok(ctx.storage.has("alphy.foryou.hidden.v1"), "dismissals untouched");
  assert.ok(ctx.storage.has("alphy.foryou.last.v1"), "cached row untouched");
});

test("boot drops legacy false 0+ caches once without touching user state", async () => {
  const now = Date.now();
  const seed = new Map();
  seed.set("alphy.cache.meta:301", JSON.stringify({
    v: { kpId: 301, title: "Старый ответ", ageRating: 0, ratingMpaa: "pg13" },
    exp: now + 86400e3,
  }));
  seed.set("alphy.cache.meta:309", JSON.stringify({
    v: { kpId: 309, title: "Нормальный ответ", ageRating: 16 },
    exp: now + 86400e3,
  }));
  seed.set("alphy.history", JSON.stringify([{ key: "kp:301", title: "Старый ответ" }]));
  const ctx = makeSandbox({ storageSeed: seed });
  ctx.run();
  await sleep(100);
  assert.equal(ctx.storage.has("alphy.cache.meta:301"), false, "ambiguous old 0+ is refetched");
  assert.ok(ctx.storage.has("alphy.cache.meta:309"), "valid age metadata stays warm");
  assert.ok(ctx.storage.has("alphy.history"), "history is not part of the cache migration");
  assert.equal(ctx.storage.get("alphy.migration.ageRating.v1"), "1");
});

test("curated click meta handoff survives quota exhaustion", async () => {
  const seed = new Map();
  let junkSize = 0;
  for (let i = 0; i < 40; i += 1) {
    const key = `alphy.cache.zona:junk${i}`;
    const value = JSON.stringify({ v: "x".repeat(2000), exp: Date.now() - 3600e3 });
    seed.set(key, value); junkSize += key.length + value.length;
  }
  const ctx = makeSandbox({ storageSeed: seed, startPath: "/", quotaLimit: junkSize + 1500 });
  ctx.run();
  await sleep(150);
  ctx.sandbox.window.alphyBridge.openCuratedItem(CATALOG.lists[0].items[0]);
  await sleep(300);
  const ortmetaRaw = ctx.storage.get(`alphy.cache.ortmeta:${EMBED}`);
  const ortmeta = ortmetaRaw ? JSON.parse(ortmetaRaw).v : null;
  assert.equal(ortmeta?.title, "Обсессия", "ortmeta handoff written despite quota pressure");
  const junkLeft = [...ctx.storage.keys()].filter((k) => k.startsWith("alphy.cache.zona:junk")).length;
  assert.equal(junkLeft, 0, "expired cache entries evicted to free space");
  const hist = JSON.parse(ctx.storage.get("alphy.history") || "[]");
  assert.equal(hist.find((h) => h.key === ORT_KEY)?.title, "Обсессия", "history entry carries the curated title");
});

test("age badge distinguishes missing age from a real 0+ and falls back to MPAA", () => {
  const ctx = makeSandbox();
  ctx.run();
  const ageBadge = ctx.sandbox.window.alphyBridge._test.ageBadge;
  assert.equal(ageBadge({ ageRating: null }), "");
  assert.equal(ageBadge({ ageRating: null, ratingMpaa: "pg13" }), "PG-13");
  assert.equal(ageBadge({ ageRating: 0 }), "0+");
  assert.equal(ageBadge({ ageRating: 12, ratingMpaa: "r" }), "12+");
});

test("history collapses provider aliases by kpId and keeps route, progress, and rich meta", () => {
  const ctx = makeSandbox();
  ctx.run();
  const { collapseHistory, historyEntryMeta } = ctx.sandbox.window.alphyBridge._test;
  const entries = collapseHistory([
    {
      key: "lift:86284", kind: "lift", kpId: "1048334",
      target: { kind: "lift", liftId: "86284", kpId: "1048334" },
      title: "Логан", poster: "poster.webp", year: "2017",
      meta: {
        kpId: "1048334", title: "Логан", year: "2017", poster: "poster.webp",
        description: "Пожилой Логан защищает юного мутанта.",
        rating: { kp: 8.0, imdb: 8.1 }, externalId: { imdb: "tt3315342" },
        genres: ["фантастика"], countries: ["США"], metaLevel: "full",
      },
      position: 0, duration: 0, progress: 0, updatedAt: 200,
    },
    {
      key: "kp:1048334", kind: "kp", kpId: "1048334",
      target: { kind: "kp", kpId: "1048334" }, title: "Логан", year: "2017",
      position: 1800, duration: 8220, progress: 0.219, updatedAt: 100,
    },
  ]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].key, "kp:1048334");
  assert.equal(entries[0].target.kind, "lift", "latest working provider route survives");
  assert.equal(entries[0].position, 1800, "older real progress survives a newer open event");
  const meta = historyEntryMeta(entries[0]);
  assert.equal(meta.description, "Пожилой Логан защищает юного мутанта.");
  assert.equal(meta.externalId.imdb, "tt3315342");
  assert.equal(meta.rating.imdb, 8.1);
});

test("home boot migrates already-stored kp and provider duplicates", async () => {
  const seed = new Map([["alphy.history", JSON.stringify([
    {
      key: "lift:86284", kind: "lift", kpId: "1048334",
      target: { kind: "lift", liftId: "86284", kpId: "1048334" },
      title: "Логан", year: "2017", updatedAt: 200,
    },
    {
      key: "kp:1048334", kind: "kp", kpId: "1048334",
      target: { kind: "kp", kpId: "1048334" },
      title: "Логан", year: "2017", updatedAt: 100,
    },
  ])]]);
  const ctx = makeSandbox({ storageSeed: seed });
  ctx.run();
  await sleep(80);
  const history = JSON.parse(ctx.storage.get("alphy.history") || "[]");
  assert.equal(history.length, 1);
  assert.equal(history[0].key, "kp:1048334");
  assert.equal(history[0].target.kind, "lift");
});

test("summary metadata never blocks a later full movie fetch", () => {
  const ctx = makeSandbox();
  ctx.run();
  const { metadataIsFull } = ctx.sandbox.window.alphyBridge._test;
  assert.equal(metadataIsFull({ title: "Логан", year: 2017, poster: "x", rating: { kp: 8 }, metaLevel: "summary" }), false);
  assert.equal(metadataIsFull({
    title: "Логан", year: 2017, poster: "x", rating: { kp: 8, imdb: 8.1 },
    externalId: { imdb: "tt3315342" }, genres: ["драма"], countries: ["США"],
  }), false, "legacy search payload with many fields still needs a synopsis fetch");
  assert.equal(metadataIsFull({
    title: "Логан", year: 2017, description: "Описание", rating: { kp: 8, imdb: 8.1 },
    externalId: { imdb: "tt3315342" }, genres: ["драма"], metaLevel: "full",
  }), true);
});
