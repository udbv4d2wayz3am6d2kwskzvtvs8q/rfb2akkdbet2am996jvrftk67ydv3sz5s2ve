import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  SafetyStop,
  assertRunAuthorized,
  bestQuality,
  buildProbeQueue,
  loadSoapCandidates,
  matchKinopoiskCandidate,
  normalizeTitle,
  parseConfig,
  runPipeline,
} from "../scripts/collaps-4k-pipeline.mjs";

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "alphy-collaps4k-"));
}

test("SOAP seed keeps only titles above 1080p and distrusts legacy title-years", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "soap.json");
  await fs.writeFile(file, JSON.stringify({ movies: [
    { id: "1", t: "Blade Runner 2049", y: "2049", q: "4K", w: 3840, h: 1600 },
    { id: "2", t: "HD Film", q: "1080", w: 1920, h: 1080 },
    { id: "3", t: "Wide Film", q: "4K", w: 2560, h: 1080 },
  ] }));
  const candidates = await loadSoapCandidates(file);
  assert.deepEqual(candidates.map((item) => item.key), ["soap:1", "soap:3"]);
  assert.equal(candidates[0].year, null, "2049 in the title must not become a release year");
});

test("title matching is exact, type-aware, and never guesses an ambiguous remake", () => {
  assert.equal(normalizeTitle("Deadpool & Wolverine"), normalizeTitle("Deadpool and Wolverine"));
  const candidate = { title: "Ballerina", year: null, isSeries: false };
  const ambiguous = matchKinopoiskCandidate(candidate, [
    { filmId: 1, nameEn: "Ballerina", year: "2016", type: "FILM" },
    { filmId: 2, nameEn: "Ballerina", year: "2025", type: "FILM" },
  ]);
  assert.equal(ambiguous.status, "ambiguous");
  assert.equal(ambiguous.suggestions.length, 2);

  const exact = matchKinopoiskCandidate({ ...candidate, year: 2025 }, [
    { filmId: 1, nameEn: "Ballerina", year: "2016", type: "FILM" },
    { filmId: 2, nameEn: "Ballerina", year: "2025", type: "FILM" },
    { filmId: 3, nameEn: "Ballerina Stories", year: "2025", type: "FILM" },
  ]);
  assert.equal(exact.status, "mapped");
  assert.equal(exact.kpId, "2");
});

test("quality detector counts 1440p/2K/4K but does not promote 1080p", () => {
  assert.deepEqual(bestQuality({ mpeg2kUrl: "https://media/4k" }), { key: "mpeg2kUrl", label: "4K", height: 2160 });
  assert.deepEqual(bestQuality({ mpeg4kUrl: "https://media/2k", mpegFullHdUrl: "https://media/1080" }), { key: "mpeg4kUrl", label: "2K", height: 1440 });
  assert.deepEqual(bestQuality({ mpeg2kUrl: "https://media/4k", mpeg4kUrl: "https://media/2k" }), { key: "mpeg2kUrl", label: "4K", height: 2160 });
  assert.equal(bestQuality({ mpegFullHdUrl: "https://media/1080" }).height, 1080);
});

test("staged series queue samples first/middle/last episodes with bounded voices", () => {
  const items = [];
  for (let season = 1; season <= 2; season += 1) {
    for (let episode = 1; episode <= 5; episode += 1) {
      for (let voice = 1; voice <= 3; voice += 1) {
        items.push({ vkId: `${season}-${episode}-${voice}`, season, episode, voiceStudio: `V${voice}` });
      }
    }
  }
  const probe = buildProbeQueue(items, {
    isSeries: true,
    seriesMode: "staged",
    seriesSamples: 3,
    voicesPerEpisode: 2,
    maxSeriesVideos: 48,
  });
  assert.equal(probe.queue.length, 12);
  assert.equal(probe.sampledEpisodes, 6);
  assert.deepEqual([...new Set(probe.queue.filter((item) => item.season === 1).map((item) => item.episode))], [1, 3, 5]);
  assert.equal(probe.complete, false);
});

test("quick series queue samples globally spaced seasons", () => {
  const items = [];
  for (let season = 1; season <= 5; season += 1) {
    for (let episode = 1; episode <= 3; episode += 1) {
      items.push({ vkId: `${season}-${episode}`, season, episode });
    }
  }
  const probe = buildProbeQueue(items, {
    isSeries: true,
    seriesMode: "quick",
    seriesSeasonSamples: 3,
    seriesSamples: 1,
    voicesPerEpisode: 1,
    maxSeriesVideos: 3,
  });
  assert.deepEqual(probe.queue.map((item) => [item.season, item.episode]), [[1, 1], [3, 1], [5, 1]]);
  assert.equal(probe.complete, false);
});

test("network run is impossible without the explicit confirmation phrase", () => {
  const config = parseConfig(["run"]);
  assert.throws(() => assertRunAuthorized(config), (error) => error instanceof SafetyStop && error.code === "confirmation_required");
  assert.throws(() => parseConfig(["run", "--min-delay-ms", "249"]), /Invalid --min-delay-ms/);
  assert.throws(() => parseConfig(["plan", "--min-dealy-ms", "300"]), /Unknown option/);
});

test("plan mode reads fixtures but cannot invoke fetch", async () => {
  const dir = await tempDir();
  const input = path.join(dir, "input.json");
  await fs.writeFile(input, JSON.stringify({ candidates: [
    { title: "Arrival", kpId: "718811", year: 2016, isSeries: false },
  ] }));
  const config = parseConfig([
    "plan",
    "--sources", "",
    "--input", input,
    "--out-dir", path.join(dir, "out"),
  ]);
  const result = await runPipeline(config, {
    fetchImpl: async () => { throw new Error("offline plan attempted a network request"); },
    env: {},
  });
  assert.equal(result.networkStarted, false);
  assert.equal(result.candidates, 1);
});

test("status reads only its checkpoint and does not require candidate sources", async () => {
  const dir = await tempDir();
  const outDir = path.join(dir, "out");
  await fs.mkdir(outDir);
  await fs.writeFile(path.join(outDir, "state.json"), JSON.stringify({
    schema: 1,
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:00.000Z",
    mappings: {},
    scans: {},
    metrics: { requests: 0, byHost: {} },
    lastRun: null,
  }));
  const config = parseConfig([
    "status",
    "--out-dir", outDir,
    "--soap", path.join(dir, "missing-soap.json"),
    "--curated", path.join(dir, "missing-curated.json"),
  ]);
  const result = await runPipeline(config);
  assert.equal(result.metrics.requests, 0);
});

test("fake end-to-end run checkpoints, strips signed URLs, and resumes with zero requests", async () => {
  const dir = await tempDir();
  const input = path.join(dir, "input.json");
  const outDir = path.join(dir, "out");
  await fs.writeFile(input, JSON.stringify({ candidates: [
    { title: "The Matrix", kpId: "301", year: 1999, isSeries: false, source: "fixture" },
  ] }));

  const calls = [];
  const fakeFetch = async (inputUrl) => {
    const url = String(inputUrl);
    calls.push(url);
    const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (url.includes("/playlist?")) return json({
      titleName: "Матрица (1999",
      isSerial: false,
      items: [
        { vkId: "v1", voiceStudio: "Voice 1" },
        { vkId: "v2", voiceStudio: "Voice 2" },
      ],
    });
    if (url.endsWith("/video/v1")) return json({ sources: { mpegFullHdUrl: "https://signed.example/secret-1080" } });
    if (url.endsWith("/video/v2")) return json({ sources: { mpeg2kUrl: "https://signed.example/secret-2k" } });
    throw new Error(`unexpected URL ${url}`);
  };
  const config = parseConfig([
    "run",
    "--confirm", "COLLAPS_4K_SCAN",
    "--sources", "",
    "--input", input,
    "--out-dir", outDir,
    "--min-delay-ms", "300",
    "--max-delay-ms", "700",
  ]);
  const deps = {
    env: {},
    fetchImpl: fakeFetch,
    sleep: async () => {},
    random: () => 0,
    now: () => 1000,
    event: async () => {},
    handleSignals: false,
  };
  const first = await runPipeline(config, deps);
  assert.equal(first.confirmedHighRes, 1);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((url) => new URL(url).pathname), [
    "/api/v1/player/sv/playlist",
    "/api/v1/player/sv/video/v1",
    "/api/v1/player/sv/video/v2",
  ]);
  const stateText = await fs.readFile(path.join(outDir, "state.json"), "utf8");
  const resultText = await fs.readFile(path.join(outDir, "collaps-4k.json"), "utf8");
  assert.doesNotMatch(stateText + resultText, /signed\.example|secret-2k/);
  assert.equal(await fs.readFile(path.join(outDir, "collaps-4k-titles.txt"), "utf8"), "Матрица (1999)\n");

  calls.length = 0;
  const resumed = await runPipeline(config, deps);
  assert.equal(resumed.confirmedHighRes, 1);
  assert.equal(calls.length, 0, "completed mapping and scan must resume without network");
});

test("metadata mapper rotates an exhausted free key without persisting either secret", async () => {
  const dir = await tempDir();
  const input = path.join(dir, "input.json");
  const outDir = path.join(dir, "out");
  await fs.writeFile(input, JSON.stringify({ candidates: [
    { title: "Avatar", isSeries: false, source: "fixture" },
  ] }));

  const usedKeys = [];
  const fakeFetch = async (inputUrl, init = {}) => {
    const url = String(inputUrl);
    const json = (body, status = 200) => new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
    if (url.includes("kinopoiskapiunofficial.tech")) {
      const key = new Headers(init.headers).get("x-api-key");
      usedKeys.push(key);
      if (key === "spent-secret") return json({ message: "quota" }, 429);
      return json({ films: [
        { filmId: 505898, nameRu: "Аватар", nameEn: "Avatar", year: "2009", type: "FILM" },
      ] });
    }
    if (url.includes("/playlist?")) return json({
      titleName: "Аватар",
      items: [{ vkId: "avatar-v1" }],
    });
    if (url.endsWith("/video/avatar-v1")) {
      return json({ sources: { mpeg4kUrl: "https://signed.example/avatar" } });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const config = parseConfig([
    "run",
    "--confirm", "COLLAPS_4K_SCAN",
    "--sources", "",
    "--input", input,
    "--out-dir", outDir,
  ]);
  const result = await runPipeline(config, {
    env: { KINOPOISK_UNOFFICIAL_TOKENS: "spent-secret,good-secret" },
    fetchImpl: fakeFetch,
    sleep: async () => {},
    random: () => 0,
    now: () => 1000,
    event: async () => {},
    handleSignals: false,
  });

  assert.deepEqual(usedKeys, ["spent-secret", "good-secret"]);
  assert.equal(result.confirmedHighRes, 1);
  const persisted = await fs.readFile(path.join(outDir, "state.json"), "utf8");
  assert.doesNotMatch(persisted, /spent-secret|good-secret|signed\.example/);
});

test("an unavailable playlist item does not turn the whole title into an error", async () => {
  const dir = await tempDir();
  const input = path.join(dir, "input.json");
  const outDir = path.join(dir, "out");
  await fs.writeFile(input, JSON.stringify({ candidates: [
    { title: "Example", kpId: "42", year: 2020, isSeries: false },
  ] }));
  const fakeFetch = async (inputUrl) => {
    const url = String(inputUrl);
    const json = (body, status = 200) => new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
    if (url.includes("/playlist?")) return json({ items: [{ vkId: "ok" }, { vkId: "stale" }] });
    if (url.endsWith("/video/ok")) return json({ sources: { mpegFullHdUrl: "https://signed.example/1080" } });
    if (url.endsWith("/video/stale")) return json({ message: "video unavailable" }, 400);
    throw new Error(`unexpected URL ${url}`);
  };
  const config = parseConfig([
    "run",
    "--confirm", "COLLAPS_4K_SCAN",
    "--sources", "",
    "--input", input,
    "--out-dir", outDir,
  ]);
  const result = await runPipeline(config, {
    fetchImpl: fakeFetch,
    sleep: async () => {},
    random: () => 0,
    now: () => 1000,
    event: async () => {},
    handleSignals: false,
  });
  assert.equal(result.confirmedNoHighRes, 1);
  const state = JSON.parse(await fs.readFile(path.join(outDir, "state.json"), "utf8"));
  assert.equal(state.scans["42"].status, "confirmed_no_high_res");
  assert.equal(state.scans["42"].scanned.stale.unavailable, "http_400");
});

test("an empty successful playlist response is a clean no-collaps miss", async () => {
  const dir = await tempDir();
  const input = path.join(dir, "input.json");
  const outDir = path.join(dir, "out");
  await fs.writeFile(input, JSON.stringify({ candidates: [
    { title: "Missing", kpId: "404", isSeries: false },
  ] }));
  const config = parseConfig([
    "run", "--confirm", "COLLAPS_4K_SCAN",
    "--sources", "", "--input", input, "--out-dir", outDir,
  ]);
  const result = await runPipeline(config, {
    fetchImpl: async () => new Response("", { status: 200 }),
    sleep: async () => {},
    random: () => 0,
    now: () => 1000,
    event: async () => {},
    handleSignals: false,
  });
  assert.equal(result.noCollaps, 1);
  const state = JSON.parse(await fs.readFile(path.join(outDir, "state.json"), "utf8"));
  assert.equal(state.scans["404"].status, "no_collaps");
});

test("a sampled miss is terminal on resume but refresh rebuilds its probe", async () => {
  const dir = await tempDir();
  const input = path.join(dir, "input.json");
  const outDir = path.join(dir, "out");
  await fs.writeFile(input, JSON.stringify({ candidates: [
    { title: "Series", kpId: "77", isSeries: true },
  ] }));
  const calls = [];
  const fakeFetch = async (inputUrl) => {
    const url = String(inputUrl);
    calls.push(url);
    if (url.includes("/playlist?")) return new Response(JSON.stringify({
      isSerial: true,
      items: [
        { vkId: "s1e1", season: 1, episode: 1 },
        { vkId: "s2e1", season: 2, episode: 1 },
      ],
    }), { status: 200 });
    return new Response(JSON.stringify({ sources: { mpegFullHdUrl: "https://signed.example/1080" } }), { status: 200 });
  };
  const args = [
    "run", "--confirm", "COLLAPS_4K_SCAN", "--sources", "", "--input", input,
    "--out-dir", outDir, "--series-mode", "quick", "--series-season-samples", "1",
    "--series-samples", "1", "--voices-per-episode", "1", "--max-series-videos", "1",
  ];
  const dependencies = {
    fetchImpl: fakeFetch,
    sleep: async () => {},
    random: () => 0,
    now: () => 1000,
    event: async () => {},
    handleSignals: false,
  };
  const first = await runPipeline(parseConfig(args), dependencies);
  assert.equal(first.sampledNoHighRes, 1);
  assert.equal(calls.length, 2);

  calls.length = 0;
  await runPipeline(parseConfig(args), dependencies);
  assert.equal(calls.length, 0, "sampled result should be a quiet terminal checkpoint");

  calls.length = 0;
  await runPipeline(parseConfig([...args, "--refresh"]), dependencies);
  assert.equal(calls.length, 2, "refresh should reload the playlist and revalidate its selected video evidence");
});
