import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const output = new URL("../dist/", import.meta.url);
const placeholder = "__ALPHY_ASSET_REV__";
const integrityPlaceholder = "__ALPHY_ASSET_INTEGRITY__";
const bootAssets = [
  "app-shell.html",
  "styles.css",
  "identity.js",
  "foryou.js",
  "catalog-cache.js",
  "shaka-smooth.js",
  "app.js",
  "catalog.js",
  "keypool.js",
];
const staticAssets = [
  "app-shell.html",
  "styles.css",
  "favicon.ico",
  "continue-play.png",
  "Logo.png",
  "identity.js",
  "foryou.js",
  "catalog-cache.js",
  "shaka-smooth.js",
  "app.js",
  "catalog.js",
  "keypool.js",
  "imdb-map.json",
  "soap-movies.json",
  "curated-fallback.json",
  "curated-config.json",
];

function gitRevision() {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: fileURLToPath(root),
    encoding: "utf8",
  }).trim();
}

const revision = String(
  process.env.ALPHY_ASSET_REVISION ||
  process.env.VERCEL_GIT_COMMIT_SHA ||
  gitRevision()
).trim();

if (!/^[0-9a-f]{40}$/i.test(revision)) {
  throw new Error(`Invalid asset revision: ${revision || "(empty)"}`);
}

const template = await readFile(new URL("index.html", root), "utf8");
if (!template.includes(placeholder) || !template.includes(integrityPlaceholder)) {
  throw new Error("index.html is missing an asset build placeholder");
}

const integrity = {};
for (const asset of bootAssets) {
  integrity[asset] = createHash("sha256")
    .update(await readFile(new URL(asset, root)))
    .digest("hex");
}

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await writeFile(new URL("index.html", output), template
  .replaceAll(placeholder, revision)
  .replace(integrityPlaceholder, JSON.stringify(integrity)));

for (const asset of staticAssets) {
  await copyFile(new URL(asset, root), new URL(asset, output));
}

console.log(`Built Vercel shell for immutable asset revision ${revision}`);
