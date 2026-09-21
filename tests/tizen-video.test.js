import test from "node:test";
import assert from "node:assert/strict";
import { makeSandbox, sleep } from "./helpers/app-sandbox.js";

const TIZEN_UA = "Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.0) AppleWebKit/537.36 SamsungBrowser/3.0 TV Safari/537.36";
const SOURCES = { hls: "h264", dash: "vp9", dasha: "av1" };
const plain = (value) => JSON.parse(JSON.stringify(value));

async function helpersFor(options = {}) {
  const ctx = makeSandbox(options);
  ctx.sandbox.MediaSource = { isTypeSupported: () => true };
  ctx.run();
  await sleep(80);
  return ctx.sandbox.window.alphyBridge._test;
}

test("Samsung Tizen video mode is narrowly UA-gated", async () => {
  const tizen = await helpersFor({ userAgent: TIZEN_UA });
  assert.equal(tizen.tizenVideoMode, true);
  assert.equal(tizen.samsungTizenVideoDevice(), true);
  assert.equal(tizen.weakVideoDevice(), true);

  const desktop = await helpersFor({ userAgent: "Mozilla/5.0 Chrome/140 Safari/537.36", hardwareConcurrency: 8 });
  assert.equal(desktop.tizenVideoMode, false);
  assert.equal(desktop.samsungTizenVideoDevice(), false);
  assert.equal(desktop.weakVideoDevice(), false);
});

test("Tizen chooses hardware-friendly HLS without changing desktop codec selection", async () => {
  const tizen = await helpersFor({ userAgent: TIZEN_UA });
  assert.deepEqual(plain(tizen.bestLiftwSource(SOURCES)), { url: "h264", kind: "hls" });
  assert.deepEqual(plain(tizen.bestZenithSource(SOURCES)), { url: "h264", kind: "hls" });
  assert.equal(tizen.soapHlsConfig().maxDevicePixelRatio, 2);

  const desktop = await helpersFor();
  assert.deepEqual(plain(desktop.bestLiftwSource(SOURCES)), { url: "av1", kind: "dasha" });
  assert.deepEqual(plain(desktop.bestZenithSource(SOURCES)), { url: "vp9", kind: "dash" });
  assert.equal(desktop.soapHlsConfig().maxDevicePixelRatio, 2);
});

test("Tizen preserves an explicit Collaps quality selection", async () => {
  const tizen = await helpersFor({ userAgent: TIZEN_UA });
  const sources = [
    { key: "mpeg2kUrl", height: 2160, url: "4k" },
    { key: "mpegFullHdUrl", height: 1080, url: "1080" },
  ];
  assert.equal(tizen.chooseCollapsSource(sources, "mpeg2kUrl").url, "4k");
});

test("Tizen Ortified hook reports position only, and drops the 1.5 second DOM poll", async () => {
  const tizen = await helpersFor({ userAgent: TIZEN_UA });
  const hook = tizen.progressHook();
  // Frame capture is gone for every device, not just this one — the readback
  // stuttered playback on any weak GPU, a projector included.
  assert.doesNotMatch(hook, /toDataURL|drawImage|SNAPSHOT/);
  assert.match(hook, /const SEND_MS = 30000/);
  assert.match(hook, /new MutationObserver\(discover\)/);
  assert.doesNotMatch(hook, /addEventListener\('timeupdate'/);
  assert.doesNotMatch(hook, /\}, 1500\)/);

  const desktop = await helpersFor();
  assert.match(desktop.progressHook(), /addEventListener\('timeupdate'/);
});

test("Tizen Ortified cleanroom forces HLS and removes optional player work", async () => {
  const tizen = await helpersFor({ userAgent: TIZEN_UA });
  const html = `<!doctype html><html><head></head><body><script>
    function makePlayer(opts) { app = VenomPlayer.make(opts) }
    makePlayer({ source: { hls: 'h', dash: 'v', dasha: 'a' } });
  </script></body></html>`;
  const result = tizen.sanitizeOrtifiedHtml(html, "https://api.ortified.ws/embed/movie/1", "test");
  assert.equal(result.stats.ok, true);
  assert.equal(result.stats.tizenPatched, true);
  assert.match(result.html, /__ALPHY_TIZEN_VIDEO__=true/);
  assert.match(result.html, /delete source\.dash/);
  assert.match(result.html, /opts\.p2p = false/);
  assert.match(result.html, /opts\.preview = false/);
  assert.match(result.html, /opts\.stats = \[\]/);

  const desktop = await helpersFor();
  const regular = desktop.sanitizeOrtifiedHtml(html, "https://api.ortified.ws/embed/movie/1", "test");
  assert.doesNotMatch(regular.html, /__ALPHY_TIZEN_VIDEO__/);
  assert.doesNotMatch(regular.html, /opts\.p2p = false/);
});

test("Tizen retries autoplay only for saved-position resume", async () => {
  const tizen = await helpersFor({ userAgent: TIZEN_UA });
  let plays = 0;
  const video = {
    readyState: 2,
    focus: () => {},
    play: () => { plays += 1; return Promise.resolve(); },
  };
  tizen.startPlaybackIfAllowed(video);
  assert.equal(plays, 0);
  tizen.startPlaybackIfAllowed(video, { resume: true });
  assert.equal(plays, 1);

  const desktop = await helpersFor();
  desktop.startPlaybackIfAllowed(video, { resume: true });
  assert.equal(plays, 1, "desktop keeps the existing no-autoplay policy");
});

test("Tizen carries a card click as a one-shot playback intent", async () => {
  const bridge = await helpersFor({ userAgent: TIZEN_UA });
  bridge.carryTizenPlayIntent();
  let plays = 0;
  bridge.startPlaybackIfAllowed({
    readyState: 2,
    focus: () => {},
    play: () => { plays += 1; return Promise.resolve(); },
  });
  assert.equal(plays, 1);
  bridge.startPlaybackIfAllowed({
    readyState: 2,
    play: () => { plays += 1; return Promise.resolve(); },
  });
  assert.equal(plays, 1, "the intent is consumed by the first player");
});
