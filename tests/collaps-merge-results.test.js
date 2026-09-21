import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { mergeCollapsResults, writeMergedOutputs } from "../scripts/collaps-merge-results.mjs";

test("merge deduplicates by KP ID and keeps only sanitized high-resolution metadata", async () => {
  const inputs = [
    { catalog: "seed", items: [
      { kpId: "1", title: "Movie", isSeries: false, quality: { label: "2K", height: 1440, url: "https://signed.example/a" }, sources: ["soap"] },
      { kpId: "2", title: "Series", isSeries: true, quality: { label: "4K", height: 2160, season: 2, episode: 1 } },
      { kpId: "3", title: "Only HD", quality: { label: "1080p", height: 1080 } },
    ] },
    { catalog: "popular", items: [
      { kpId: "1", title: "Movie", isSeries: false, quality: { label: "4K", height: 2160, url: "https://signed.example/b" }, sources: ["kp"] },
    ] },
  ];
  const result = mergeCollapsResults(inputs);
  assert.deepEqual(result.summary, {
    inputItems: 4,
    acceptedItems: 3,
    uniqueItems: 2,
    duplicateItems: 1,
    excludedItems: 1,
    movies: 1,
    series: 1,
    byQuality: { "4K": 2 },
  });
  assert.equal(result.items[0].quality.height, 2160);
  assert.deepEqual(result.items.find((item) => item.kpId === "1").catalogs, ["seed", "popular"]);
  assert.doesNotMatch(JSON.stringify(result), /signed\.example|"url"/);

  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "alphy-collaps-merge-"));
  const summary = await writeMergedOutputs(inputs, outDir);
  assert.equal(summary.uniqueItems, 2);
  const persisted = await fs.readFile(path.join(outDir, "collaps-4k.json"), "utf8");
  assert.doesNotMatch(persisted, /signed\.example|"url"/);
  assert.match(await fs.readFile(path.join(outDir, "collaps-4k-details.tsv"), "utf8"), /Series\t\tseries\t4K\t2/);
});
