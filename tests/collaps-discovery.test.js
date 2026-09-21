import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  mergeDiscoveredCandidates,
  normalizeCollectionCandidate,
  parseDiscoveryConfig,
  runDiscovery,
} from "../scripts/collaps-discover-candidates.mjs";

test("collection candidates preserve KP ids and classify series", () => {
  const collection = { type: "POPULAR_SERIES", priority: 98 };
  const value = normalizeCollectionCandidate({
    kinopoiskId: 464963,
    nameRu: "Игра престолов",
    year: 2011,
    type: "TV_SERIES",
  }, collection, 1);
  assert.equal(value.kpId, "464963");
  assert.equal(value.isSeries, true);
  assert.deepEqual(value.collections, ["POPULAR_SERIES"]);
});

test("candidate merge deduplicates overlapping collections", () => {
  const movie = { key: "kp:301", kpId: "301", title: "Матрица", isSeries: false, priority: 90, collections: ["A"], collectionRanks: { A: 5 } };
  const duplicate = { ...movie, priority: 100, collections: ["B"], collectionRanks: { B: 2 } };
  const merged = mergeDiscoveredCandidates({ a: { items: [movie] }, b: { items: [duplicate] } });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].priority, 100);
  assert.deepEqual(merged[0].collections.sort(), ["A", "B"]);
});

test("discovery is guarded, checkpoints pages, and resumes without requests", async () => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "alphy-collaps-discovery-"));
  assert.rejects(
    runDiscovery(parseDiscoveryConfig(["run", "--out-dir", outDir]), { env: {} }),
    (error) => error?.code === "confirmation_required",
  );
  const calls = [];
  const fakeFetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url.href);
    const page = Number(url.searchParams.get("page"));
    return new Response(JSON.stringify({
      total: 2,
      totalPages: 2,
      items: [{ kinopoiskId: 100 + page, nameRu: `Фильм ${page}`, year: 2020 + page, type: "FILM" }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const config = parseDiscoveryConfig([
    "run", "--confirm", "COLLAPS_KP_DISCOVERY",
    "--collections", "TOP_250_MOVIES",
    "--out-dir", outDir,
  ]);
  const deps = {
    env: { KINOPOISK_UNOFFICIAL_TOKENS: "fixture-key" },
    fetchImpl: fakeFetch,
    sleep: async () => {},
    random: () => 0,
    now: () => 1000,
    handleSignals: false,
  };
  const first = await runDiscovery(config, deps);
  assert.equal(first.total, 2);
  assert.equal(first.pages, 2);
  assert.equal(calls.length, 2);
  calls.length = 0;
  const resumed = await runDiscovery(config, deps);
  assert.equal(resumed.total, 2);
  assert.equal(calls.length, 0);
  const persisted = await fs.readFile(path.join(outDir, "state.json"), "utf8");
  assert.doesNotMatch(persisted, /fixture-key/);
});
