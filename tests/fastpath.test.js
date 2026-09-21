import test from "node:test";
import assert from "node:assert/strict";
import { makeSandbox, sleep } from "./helpers/app-sandbox.js";

// Source priority for /k/:kpId clicks (resolveKpPlaybackSource):
//   1. cached Zona + mid-watch progress → Zenith (resume/озвучка live under kp:)
//   2. verified KP→LiftW cache → LiftW
//   3. warmed Collaps probe → Collaps (the hover/idle prefetch must pay off)
//   4. cached Zona → Zenith
//   5. cold → Collaps fast window, then Zona resolver
// All cached branches must return without touching the network.

const ZONA = JSON.stringify({ v: { zenithId: "777", embedUrl: "https://z.example/embed/movie/777" }, exp: 0 });
const PROBE = JSON.stringify({
  v: { kpId: "301", title: "Матрица", qualityLabel: "1080p", qualityHeight: 1080, selection: {}, rank: 0 },
  exp: 0,
});
const LIFT = JSON.stringify({ v: "86284", exp: 0 });

async function bootedBridge(seed) {
  const ctx = makeSandbox({ storageSeed: seed });
  ctx.run();
  await sleep(80);
  return ctx.sandbox.window.alphyBridge;
}

test("warmed Collaps probe wins over a cached Zona resolve", async () => {
  const seed = new Map([["alphy.cache.zona:301", ZONA], ["alphy.cache.clpsprobe:301", PROBE]]);
  const bridge = await bootedBridge(seed);
  const source = await bridge.resolveKpPlaybackSource("301");
  assert.equal(source.kind, "clps", "prefetched Collaps beats the slower Zenith chain");
  assert.equal(source.hit.kpId, "301");
});

test("verified LiftW mapping wins over cached Collaps and Zona", async () => {
  const seed = new Map([
    ["alphy.cache.zona:301", ZONA],
    ["alphy.cache.clpsprobe:301", PROBE],
    ["alphy.cache.liftwbykp.v2:301", LIFT],
  ]);
  const bridge = await bootedBridge(seed);
  const source = await bridge.resolveKpPlaybackSource("301");
  assert.equal(source.kind, "lift");
  assert.equal(source.liftId, "86284");
});

test("mid-watch Zenith title keeps its player despite a warmed probe", async () => {
  const seed = new Map([
    ["alphy.cache.zona:301", ZONA],
    ["alphy.cache.clpsprobe:301", PROBE],
    ["alphy.cache.liftwbykp.v2:301", LIFT],
    ["alphy.history", JSON.stringify([{
      key: "kp:301", kind: "kp", target: { kind: "kp", kpId: "301" }, title: "Матрица",
      position: 1200, duration: 8000, progress: 0.15, updatedAt: Date.now(),
    }])],
  ]);
  const bridge = await bootedBridge(seed);
  const source = await bridge.resolveKpPlaybackSource("301");
  assert.equal(source.kind, "zen", "resume position under kp: must not be lost to Collaps");
  assert.equal(source.resolved.zenithId, "777");
});

test("a finished Zenith watch releases the title back to the fast path", async () => {
  const seed = new Map([
    ["alphy.cache.zona:301", ZONA],
    ["alphy.cache.clpsprobe:301", PROBE],
    ["alphy.history", JSON.stringify([{
      key: "kp:301", kind: "kp", target: { kind: "kp", kpId: "301" }, title: "Матрица",
      position: 7900, duration: 8000, progress: 0.99, updatedAt: Date.now(),
    }])],
  ]);
  const bridge = await bootedBridge(seed);
  const source = await bridge.resolveKpPlaybackSource("301");
  assert.equal(source.kind, "clps", "rewatch starts on the fast player, resume is 0 anyway");
});

test("cached Zona alone still resolves to Zenith without any network", async () => {
  const seed = new Map([["alphy.cache.zona:301", ZONA]]);
  const bridge = await bootedBridge(seed);
  const source = await bridge.resolveKpPlaybackSource("301");
  assert.equal(source.kind, "zen");
  assert.equal(source.resolved.embedUrl, "https://z.example/embed/movie/777");
});
