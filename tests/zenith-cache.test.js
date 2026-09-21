import test from "node:test";
import assert from "node:assert/strict";
import { makeSandbox, sleep } from "./helpers/app-sandbox.js";

// Curated shelves are mostly zen: items, so "open a title that is already in a
// list" is the single hottest path on the site. Its cost used to be a resolver
// round trip EVERY time, because the parsed Zenith playlist lived only in an
// in-memory Map with a 90-second TTL. These tests pin the persisted cache:
// a warm title must reach the player without touching the network, and a cold
// one must pay exactly one request and then be warm.

const EMBED = "https://api.zenithjs.ws/embed/movie/777";
const PARSED = {
  sources: { hls: "https://cdn.example/master.m3u8" },
  meta: { audioNames: ["Дубляж"] },
  playlist: { current: null, seasons: [] },
};

function zenithSandbox({ seed = new Map(), zenithResponse } = {}) {
  const storageSeed = new Map(seed);
  storageSeed.set("alphy.zenithBrowserBlockedUntil", String(Date.now() + 60_000));
  const ctx = makeSandbox({ storageSeed });
  const calls = [];
  const baseFetch = ctx.sandbox.fetch;
  ctx.sandbox.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/zenith")) {
      calls.push(url);
      const body = zenithResponse ?? { ok: true, hasSources: true, ...PARSED };
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        json: async () => body,
        text: async () => JSON.stringify(body),
      };
    }
    // Any direct api.zenithjs.ws attempt fails, as it does for a blocked browser.
    if (url.includes("api.zenithjs.ws")) throw new Error("blocked");
    return baseFetch(input, init);
  };
  return { ctx, calls };
}

async function boot(ctx) {
  ctx.run();
  await sleep(80);
  return ctx.sandbox.window.alphyBridge;
}

test("a cached Zenith parse serves the player with zero requests", async () => {
  const seed = new Map([
    ["alphy.cache.zenith:777", JSON.stringify({ v: PARSED, exp: Date.now() + 10 * 60e3 })],
  ]);
  const { ctx, calls } = zenithSandbox({ seed });
  const bridge = await boot(ctx);

  const parsed = await bridge.resolveZenithParsed(EMBED);
  assert.equal(parsed.sources.hls, PARSED.sources.hls);
  assert.deepEqual(calls, [], "a warm title must not reach the resolver at all");
});

test("a cold title costs exactly one resolve, then is warm for the next open", async () => {
  const { ctx, calls } = zenithSandbox();
  const bridge = await boot(ctx);

  const first = await bridge.resolveZenithParsed(EMBED);
  assert.equal(first.sources.hls, PARSED.sources.hls);
  assert.equal(calls.length, 1, "cold resolve hits the resolver once");
  assert.ok(ctx.storage.has("alphy.cache.zenith:777"), "the parse is persisted for the next open");

  await bridge.resolveZenithParsed(EMBED);
  assert.equal(calls.length, 1, "the second open is free");
});

test("concurrent opens of the same title share one in-flight resolve", async () => {
  const { ctx, calls } = zenithSandbox();
  const bridge = await boot(ctx);

  // A hover prefetch and the click that follows it must not race each other.
  const [a, b] = await Promise.all([
    bridge.resolveZenithParsed(EMBED),
    bridge.resolveZenithParsed(EMBED),
  ]);
  assert.equal(a.sources.hls, b.sources.hls);
  assert.equal(calls.length, 1, "the click joins the prefetch instead of duplicating it");
});

test("a series ignores a cached parse that carries no season list", async () => {
  // A movie-shaped parse cached earlier must not strand the episode picker.
  const seed = new Map([
    ["alphy.cache.zenith:777", JSON.stringify({ v: PARSED, exp: Date.now() + 10 * 60e3 })],
  ]);
  const seasons = {
    ok: true,
    hasSources: true,
    sources: PARSED.sources,
    meta: {},
    playlist: { current: { season: 1, episode: 1 }, seasons: [{ season: 1, episodes: [{ episode: 1 }] }] },
  };
  const { ctx, calls } = zenithSandbox({ seed, zenithResponse: seasons });
  const bridge = await boot(ctx);

  const parsed = await bridge.resolveZenithParsed(EMBED, { wantSeasons: true });
  assert.equal(calls.length, 1, "an unusable cache entry is re-resolved");
  assert.equal(parsed.playlist.seasons.length, 1);
});

test("forceWorker bypasses the cache to re-mint an expired signature", async () => {
  const seed = new Map([
    ["alphy.cache.zenith:777", JSON.stringify({ v: PARSED, exp: Date.now() + 10 * 60e3 })],
  ]);
  const fresh = {
    ok: true,
    hasSources: true,
    sources: { hls: "https://cdn.example/fresh.m3u8" },
    meta: {},
    playlist: { current: null, seasons: [] },
  };
  const { ctx, calls } = zenithSandbox({ seed, zenithResponse: fresh });
  const bridge = await boot(ctx);

  const parsed = await bridge.resolveZenithParsed(EMBED, { force: true });
  assert.equal(calls.length, 1);
  assert.equal(parsed.sources.hls, "https://cdn.example/fresh.m3u8");
});
