#!/usr/bin/env node
// Resolves the curated catalogue to IMDb ids once, offline, and writes the
// answer into the repo.
//
// The catalogue is a finite, hand-picked list that changes when a human edits
// it — so its identity should be built at build time, not rediscovered by every
// visitor's browser against a metered API. An earlier pass did the latter and
// spent a day's PoiskKino quota to learn 77 facts that fit in 6KB.
//
// Cinemeta is the source: free, unmetered, CORS-open, and it resolves Russian
// titles ("Большой куш" -> Snatch) because it carries the same alias table
// Stremio ships. A candidate is only accepted when the release year is within a
// year of ours, which is what stops a common title binding to the wrong film.
//
//   node scripts/build-imdb-map.mjs [--check]
//
// Normal mode reuses every existing fact and asks Cinemeta only for new keys.
// --check is deliberately offline: CI verifies exact catalogue coverage and the
// source revision without making the build depend on a remote service.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(root, "curated-fallback.json");
const TARGET = path.join(root, "imdb-map.json");
const OVERRIDES = path.join(root, "imdb-overrides.json");
const CHECK = process.argv.includes("--check");
const IMDB_RE = /^tt\d{6,10}$/;

const normalizeTitle = (value) => String(value || "")
  .toLowerCase().replace(/ё/g, "е")
  .replace(/[^a-zа-я0-9]+/gi, " ").trim();

const mapKey = (title, year, isSeries = false) =>
  `${normalizeTitle(title)}|${String(year || "").slice(0, 4)}|${isSeries ? "s" : "f"}`;

const releaseYear = (meta) => {
  const raw = String(meta?.year ?? meta?.releaseInfo ?? "").slice(0, 4);
  const year = Number(raw);
  return Number.isFinite(year) && year > 1880 ? year : null;
};

async function cinemetaSearch(type, query) {
  const url = `https://v3-cinemeta.strem.io/catalog/${type}/top/search=${encodeURIComponent(query)}.json`;
  const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`Cinemeta ${response.status}`);
  return (await response.json())?.metas ?? [];
}

const carriedImdb = (item) => String(
  item?.externalId?.imdb || item?.externalIds?.imdb || item?.imdb || item?.imdbId || "",
).toLowerCase();

// The year is the whole safety net: without it a short title like "Драйв" would
// happily bind to whatever Cinemeta ranks first.
function pick(metas, wantedYear) {
  if (!Number.isFinite(wantedYear)) return null;
  return metas.find((meta) => {
    const year = releaseYear(meta);
    return year !== null && Math.abs(year - wantedYear) <= 1 && /^tt\d{6,10}$/.test(meta?.imdb_id || "");
  }) ?? null;
}

const catalogue = JSON.parse(fs.readFileSync(SOURCE, "utf8"));
const overrides = fs.existsSync(OVERRIDES) ? JSON.parse(fs.readFileSync(OVERRIDES, "utf8")) : {};
const items = (catalogue.lists ?? []).flatMap((list) => list.items ?? []);
const wanted = new Map();
const invalid = [];
for (const item of items) {
  const year = Number(String(item.year ?? "").slice(0, 4));
  const key = mapKey(item.title, year, !!item.isSeries);
  if (!normalizeTitle(item.title) || !Number.isFinite(year) || year <= 1880) {
    invalid.push(`${item.title || "<без названия>"} (${item.year || "без года"})`);
    continue;
  }
  if (!wanted.has(key)) wanted.set(key, { item, year, key });
}

const committed = fs.existsSync(TARGET) ? JSON.parse(fs.readFileSync(TARGET, "utf8")) : { entries: {} };
const sourceTag = `curated-fallback.json@${catalogue.revision ?? "?"}`;

if (CHECK) {
  const entries = committed?.entries || {};
  const missing = [...wanted.keys()].filter((key) => !IMDB_RE.test(String(entries[key]?.imdb || "")));
  const stale = Object.keys(entries).filter((key) => !wanted.has(key));
  const sourceMismatch = committed?.builtFrom !== sourceTag;
  if (invalid.length || missing.length || stale.length || sourceMismatch) {
    if (sourceMismatch) console.error(`imdb-map source ${committed?.builtFrom || "?"}, expected ${sourceTag}`);
    if (invalid.length) console.error(`catalogue entries without stable identity input: ${invalid.join(", ")}`);
    if (missing.length) console.error(`imdb-map missing ${missing.length}: ${missing.join(", ")}`);
    if (stale.length) console.error(`imdb-map has ${stale.length} stale keys: ${stale.join(", ")}`);
    console.error("Run: npm run refresh:identity");
    process.exit(1);
  }
  console.log(`imdb-map.json актуален: ${wanted.size} уникальных тайтлов, каталог r${catalogue.revision}`);
  process.exit(0);
}

const resolved = {};
const unresolved = [];
const queue = [...wanted.values()];
let cursor = 0;
async function worker() {
  while (cursor < queue.length) {
    const current = queue[cursor++];
    const { item, year, key } = current;
    const override = overrides[key];
    if (IMDB_RE.test(String(override?.imdb || ""))) {
      resolved[key] = {
        imdb: String(override.imdb).toLowerCase(),
        name: override.name || item.title,
        year: Number(override.year) || year,
      };
      continue;
    }
    const carried = carriedImdb(item);
    if (IMDB_RE.test(carried)) {
      resolved[key] = { imdb: carried, name: item.title, year };
      continue;
    }
    const existing = committed?.entries?.[key];
    if (IMDB_RE.test(String(existing?.imdb || ""))) {
      resolved[key] = existing;
      continue;
    }
    let hit = null;
    try {
      hit = pick(await cinemetaSearch(item.isSeries ? "series" : "movie", item.title), year);
    } catch (error) {
      unresolved.push(`${item.title} (${item.year}) — Cinemeta недоступна: ${error.message}`);
      continue;
    }
    if (!hit) {
      unresolved.push(`${item.title} (${item.year})`);
      continue;
    }
    // The matched name is stored purely so a human can audit this file in review.
    resolved[key] = { imdb: hit.imdb_id, name: hit.name, year: releaseYear(hit) };
  }
}
await Promise.all(Array.from({ length: 4 }, () => worker()));

const built = {
  note: "Собрано scripts/build-imdb-map.mjs из curated-fallback.json. Руками не править.",
  builtFrom: sourceTag,
  count: Object.keys(resolved).length,
  entries: Object.fromEntries(Object.entries(resolved).sort(([a], [b]) => a.localeCompare(b))),
};

fs.writeFileSync(TARGET, `${JSON.stringify(built, null, 2)}\n`);
console.log(`записано ${built.count} из ${wanted.size} уникальных тайтлов в imdb-map.json`);
if (unresolved.length) {
  console.log(`не сопоставлено ${unresolved.length}:`);
  for (const line of unresolved) console.log(`  ${line}`);
  process.exitCode = 1;
}
