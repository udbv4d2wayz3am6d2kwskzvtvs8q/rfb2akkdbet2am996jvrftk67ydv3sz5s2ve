import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { makeSandbox, sleep } from "./helpers/app-sandbox.js";

// LiftW hands us an AV1 and a VP9 ladder for the same film. AV1 is normally the
// better deal, but LiftW's AV1 encodes are bimodal: measured over 25 films, a
// healthy one runs 0.07-0.24 bits per pixel per frame and a starved one
// 0.010-0.032 — the same 1920-wide frame at a tenth of the data. The fixtures
// are the real manifests for both cases (Дюна starved, Начало healthy), with
// hostnames and signatures replaced.

const fixture = (name) => readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const AV1 = 'video/webm; codecs="av01';
const VP9 = 'video/webm; codecs="vp09';
const OPUS = 'audio/webm; codecs="opus';
const supports = (...types) => ({ isTypeSupported: (t) => types.some((x) => t.startsWith(x)) });

const SOURCES = {
  dasha: "https://cdn.example/av1/a/av1.mpd?t=1800000000",
  dash: "https://cdn.example/vp9/a/vp9.mpd?t=1800000000",
  hls: "https://cdn.example/h264/a/master.m3u8?t=1800000000",
};

async function ladderSandbox({ manifest, fail = false } = {}) {
  const ctx = makeSandbox();
  ctx.sandbox.MediaSource = supports(AV1, VP9, OPUS);
  ctx.run();
  await sleep(80);
  const calls = [];
  const helpers = ctx.sandbox.window.alphyBridge._test;
  helpers.setLiftwManifestFetcher(async (url) => {
    calls.push(String(url));
    if (fail) throw new Error("network down");
    return manifest;
  });
  return { helpers, calls, storage: ctx.storage };
}

test("the top rung is the biggest frame's fattest rung, and audio is not a rung", async () => {
  const { helpers } = await ladderSandbox();
  const top = helpers.topDashRepresentation(await fixture("liftw-dash-av1-starved.mpd"));
  assert.equal(top.width, 1920);
  assert.equal(top.height, 800);
  assert.equal(top.bandwidth, 362053);
  // frameRate="24000/1001" is 23.976, not 24000.
  assert.ok(Math.abs(top.fps - 23.976) < 0.01, `fps ${top.fps}`);

  // "bandwidth" ends in "width", so an unanchored /width="/ reads the bitrate as
  // the frame width — which is exactly how this went wrong once already.
  const trap = '<Representation bandwidth="4562078" width="1272" height="530" frameRate="24"></Representation>';
  assert.equal(helpers.topDashRepresentation(trap).width, 1272);
  assert.equal(helpers.topDashRepresentation("<MPD></MPD>"), null);
});

test("a starved AV1 ladder is dropped for VP9, a healthy one is kept", async () => {
  const starved = await ladderSandbox({ manifest: await fixture("liftw-dash-av1-starved.mpd") });
  // Дюна: 1920x800 at 0.36 Mbps, against 3.42 Mbps of VP9 at the same frame.
  assert.deepEqual(
    JSON.parse(JSON.stringify(await starved.helpers.pickLiftwLadder(SOURCES))),
    { url: SOURCES.dash, kind: "dash" },
  );

  const healthy = await ladderSandbox({ manifest: await fixture("liftw-dash-av1-healthy.mpd") });
  // Начало: 1920x800 at 8.86 Mbps — a real AV1 encode, and cheaper than VP9.
  assert.deepEqual(
    JSON.parse(JSON.stringify(await healthy.helpers.pickLiftwLadder(SOURCES))),
    { url: SOURCES.dasha, kind: "dasha" },
  );
});

test("nothing is fetched when the answer cannot change", async () => {
  // No VP9 to fall back to: whatever the AV1 bitrate is, AV1 is the only DASH
  // ladder there is. Half the sampled catalogue looks like this.
  const noVp9 = await ladderSandbox({ manifest: await fixture("liftw-dash-av1-starved.mpd") });
  const picked = await noVp9.helpers.pickLiftwLadder({ dasha: SOURCES.dasha, hls: SOURCES.hls });
  assert.equal(picked.kind, "dasha");
  assert.deepEqual(noVp9.calls, [], "probing would only cost a round trip");

  // A browser without AV1 never reaches the question either.
  const ctx = makeSandbox();
  ctx.sandbox.MediaSource = supports(VP9, OPUS);
  ctx.run();
  await sleep(80);
  const helpers = ctx.sandbox.window.alphyBridge._test;
  helpers.setLiftwManifestFetcher(async () => { throw new Error("must not be called"); });
  assert.equal((await helpers.pickLiftwLadder(SOURCES)).kind, "dash");
});

test("the probe fails safe and is paid for only once", async () => {
  const down = await ladderSandbox({ fail: true });
  assert.equal((await down.helpers.pickLiftwLadder(SOURCES)).kind, "dasha", "a broken probe keeps the old behaviour");

  const cached = await ladderSandbox({ manifest: await fixture("liftw-dash-av1-starved.mpd") });
  assert.equal((await cached.helpers.pickLiftwLadder(SOURCES)).kind, "dash");
  assert.equal((await cached.helpers.pickLiftwLadder(SOURCES)).kind, "dash");
  assert.equal(cached.calls.length, 1, "the verdict is cached against the manifest path");
  // Keyed on the path, because the ?t= signature rotates every few days.
  assert.ok([...cached.storage.keys()].some((k) => k.endsWith("liftwladder.v1:/av1/a/av1.mpd")));
});

test("a rung is named by frame width, so a scope master is not demoted", async () => {
  const { helpers } = await ladderSandbox();
  const label = (width, height) => helpers.qualityLabel({ width, height });
  // The three that started this: all are full-width 1080p masters.
  assert.equal(label(1920, 1080), "1080p");
  assert.equal(label(1920, 800), "1080p", "2.40:1 scope, read as 800p before");
  assert.equal(label(1938, 1020), "1080p", "IMAX, wider than 1920, read as 1020p before");
  assert.equal(label(1272, 530), "720p");
  assert.equal(label(1280, 720), "720p");
  assert.equal(label(864, 360), "480p");
  assert.equal(label(3840, 2160), "4K");
  assert.equal(label(3840, 1600), "4K", "scope 4K is still 4K");
  // soap ships real 4K scope masters; this one read as "1632p" before.
  assert.equal(label(3840, 1632), "4K");
  assert.equal(label(2560, 1440), "1440p");
  // A provider that reports only a height still gets a usable rung name.
  assert.equal(helpers.qualityLabel({ height: 1080 }), "1080p");
  assert.equal(helpers.qualityLabel({}), "");
  assert.equal(helpers.qualityLabel(null), "");
});
