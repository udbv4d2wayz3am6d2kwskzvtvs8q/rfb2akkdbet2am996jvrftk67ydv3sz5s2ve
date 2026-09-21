import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { makeSandbox, sleep } from "./helpers/app-sandbox.js";

async function liftwHelpers() {
  const ctx = makeSandbox();
  ctx.run();
  await sleep(80);
  return ctx.sandbox.window.alphyBridge._test;
}

test("LiftW search payload is normalized without Kinopoisk metadata calls", async () => {
  const helpers = await liftwHelpers();
  const results = helpers.normalizeLiftwSearchPayload({
    totalCount: 3,
    items: [
      {
        id: 15534,
        type: 1,
        name: "Бэтмен",
        origin_name: "The Batman",
        poster: "https://img.niteface.ws/poster-token",
        year: 2022,
        imdb_rating: 7.9,
        kp_rating: 7.9,
        quality: "FHD",
      },
      {
        id: 11991,
        type: 5,
        name: "Бэтмен",
        poster: "https://evil.example/tracker.jpg",
        year: 1992,
        imdb_rating: 9,
        kp_rating: 7.92,
        serial_status: "Все серии",
        quality: "HD",
      },
      { id: "not-an-id", type: 1, name: "bad" },
    ],
  });

  assert.equal(results.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(results[0])), {
    id: "15534",
    title: "Бэтмен",
    originalTitle: "The Batman",
    year: 2022,
    poster: "https://img.niteface.ws/poster-token",
    quality: "FHD",
    serialStatus: "",
    rating: { kp: 7.9, imdb: 7.9 },
    type: 1,
    typeLabel: "фильм",
    isSeries: false,
  });
  assert.equal(results[1].isSeries, true);
  assert.equal(results[1].typeLabel, "мультсериал");
  assert.equal(results[1].poster, "");
  assert.equal(results[1].serialStatus, "Все серии");
});

test("LiftW search never reaches LiftW from the viewer's own address", async () => {
  const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const start = source.indexOf("async function searchLiftw");
  const end = source.indexOf("function normalizeLiftwSearchPayload", start);
  const block = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  // The opaque sandbox used to hide alphy.tv from LiftW. api.liftw.ws is now
  // blocked in Russia and sends no CORS header at all, so the search goes
  // through the relay instead — which hides the viewer outright rather than
  // just their Origin. What must never come back is a direct call.
  assert.match(block, /liftwRelay\(/);
  assert.doesNotMatch(block, /api\.liftw\.ws/);
  assert.doesNotMatch(block, /preferSandbox/);
});

test("LiftW search results build in-app playback targets", async () => {
  const helpers = await liftwHelpers();
  const target = helpers.liftwTarget(15534);
  assert.equal(target.kind, "lift");
  assert.equal(helpers.hashFor(target), "/l/15534");
  assert.equal(helpers.hashFor(helpers.liftwTarget(15534, { season: 3, episode: 7 })), "/l/15534/s3e7");

  // Ids come straight off a third-party payload. A non-numeric one is emptied
  // rather than smuggled into a URL, and the hash it produces routes home
  // instead of opening a watch page that could never resolve.
  for (const bad of ["javascript:alert(1)", "../../etc", "", null, 0, -5]) {
    const target = helpers.liftwTarget(bad);
    assert.equal(target.liftId, "", `${JSON.stringify(bad)} leaked into a target`);
    assert.deepEqual(
      JSON.parse(JSON.stringify(helpers.parsePathRoute(helpers.hashFor(target)))),
      { view: "home" },
    );
  }
});

test("a LiftW card opens the internal player and warms the title on hover", async () => {
  const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const start = source.indexOf("function makeLiftwCard");
  const end = source.indexOf("function makeCollapsCard", start);
  const block = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  // The card used to hand the user off to liftw.ws. It now routes into our own
  // Shaka playback, and never leaves the site.
  assert.match(block, /onClick:\s*\(\)\s*=>\s*go\(hashFor\(target\)\)/);
  assert.match(block, /pointerenter[\s\S]*prefetchLiftwTitle/);
  assert.doesNotMatch(block, /openExternal|liftw\.ws|noopener/);
});
