import { mkdir, writeFile } from "node:fs/promises";

const snapshotUrl =
  process.env.ALPHY_CATALOG_SNAPSHOT_URL ||
  "https://alphy.tv/api/catalog-snapshot";

let response;
for (let attempt = 0; attempt < 3; attempt += 1) {
  try {
    response = await fetch(`${snapshotUrl}?snapshot=${Date.now()}`, {
      cache: "no-store", signal: AbortSignal.timeout(20000),
    });
    if (response.ok || ![502, 503, 504].includes(response.status)) break;
    await response.arrayBuffer();
  } catch (error) { if (attempt === 2) throw error; }
  if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
}
if (!response?.ok) throw new Error(`Catalog download failed: ${response?.status}`);

const catalog = await response.json();
if (!Array.isArray(catalog?.lists) || !Number.isInteger(Number(catalog?.revision))) {
  throw new Error("Catalog response is invalid");
}

const body = `${JSON.stringify(catalog, null, 2)}\n`;
const revision = Number(catalog.revision);
const stamp = new Date().toISOString().slice(0, 10);
const backupDir = new URL("../docs/catalog-backups/", import.meta.url);

await mkdir(backupDir, { recursive: true });
await writeFile(new URL("../curated-fallback.json", import.meta.url), body);
await writeFile(new URL(`curated-${stamp}-r${revision}.json`, backupDir), body);

const itemCount = catalog.lists.reduce(
  (total, list) => total + (Array.isArray(list?.items) ? list.items.length : 0),
  0,
);
console.log(`Saved catalog revision ${revision}: ${catalog.lists.length} lists, ${itemCount} items`);
