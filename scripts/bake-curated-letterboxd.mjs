#!/usr/bin/env node
// Bakes each curated film's Letterboxd score into the published catalogue.
//
// The home page is the same few hundred films for every visitor, yet each visit
// asked the Letterboxd shards for their scores again — 32 function calls to
// paint one page, which is what would have exhausted the free tier first. The
// scores move in the second decimal over months, so they belong in the snapshot
// the page already downloads, not in a request per visitor.
//
//   node scripts/bake-curated-letterboxd.mjs --catalog curated-fallback.json \
//     --map imdb-map.json [--previous previous.json] [--max-lookups 40]
//
// What it asks, and of whom:
//  - the shards' tables first, in batches, exactly as a grid would. Reading a
//    row costs no request to Letterboxd;
//  - only the films no table has looked up yet, one at a time, paced, capped per
//    run. Each such lookup is the same one opening the film would make, so it
//    also warms the table for every visitor after;
//  - nothing else. A shard that cannot answer leaves the previous published
//    value in place rather than dropping it.
//
// The snapshot changes only when a score does, so an hourly run commits rarely.
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

// Must match app.js: a film is always asked of the project its id hashes to.
export const LETTERBOXD_ENDPOINTS = [
  "https://icmjgvlsyfqwyewvsuje.supabase.co/functions/v1/letterboxd",
  "https://gzwynsvcydynqidwxjru.supabase.co/functions/v1/letterboxd",
  "https://cuyofxgofmhdugauoqzt.supabase.co/functions/v1/letterboxd",
  "https://hrtnvhafwzimjstvegno.supabase.co/functions/v1/letterboxd",
  "https://pvwrwsnzqaldyuvlttlv.supabase.co/functions/v1/letterboxd",
];
const BATCH_MAX = 60;
const IMDB_RE = /^tt\d{6,10}$/;

export function endpointFor(imdb) {
  let hash = 0;
  for (const char of String(imdb)) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  let index = hash % Math.min(LETTERBOXD_ENDPOINTS.length, 4);
  // Same rule as letterboxdShardIndex in app.js: a later project takes only its share.
  for (let n = 5; n <= LETTERBOXD_ENDPOINTS.length; n += 1) if (hash % n === n - 1) index = n - 1;
  return LETTERBOXD_ENDPOINTS[index];
}

// Same key the identity layer and build-imdb-map.mjs use.
const normalizeTitle = (value) => String(value || "")
  .toLowerCase().replace(/ё/g, "е")
  .replace(/[^a-zа-я0-9]+/gi, " ").trim();
const mapKey = (title, year, isSeries = false) =>
  `${normalizeTitle(title)}|${String(year || "").slice(0, 4)}|${isSeries ? "s" : "f"}`;
const yearOf = (value) => {
  const year = Number(String(value ?? "").slice(0, 4));
  return Number.isFinite(year) && year > 1880 && year < 2200 ? year : null;
};

const carriedImdb = (item) => String(
  item?.externalId?.imdb || item?.externalIds?.imdb || item?.imdb || item?.imdbId || "",
).toLowerCase();

// The id a visitor's browser would arrive at for this card, and nothing more
// adventurous: the carried id, else the committed map. A series is never looked
// up by title — Letterboxd carries no series, so the grid does not either.
export function imdbFor(item, mapEntries) {
  const carried = carriedImdb(item);
  if (IMDB_RE.test(carried)) return { imdb: carried, carried: true };
  if (item?.isSeries) return { imdb: "", carried: false };
  const year = yearOf(item?.year);
  const title = String(item?.title || "").trim();
  if (!title || year === null) return { imdb: "", carried: false };
  const mapped = String(mapEntries?.[mapKey(title, year, false)]?.imdb || "").toLowerCase();
  return IMDB_RE.test(mapped) ? { imdb: mapped, carried: false } : { imdb: "", carried: false };
}

// Only the fields a card already shows. A confirmed absence is { r: 0 }, the
// same shape the browser's own cache uses for it.
export function cleanScore(raw) {
  if (raw === null) return { r: 0 };
  const r = Number(raw?.r);
  if (!Number.isFinite(r) || r <= 0 || r > 5) return undefined;
  const n = Number(raw?.n);
  return {
    r,
    n: Number.isInteger(n) && n > 0 ? n : null,
    slug: String(raw?.slug || "").trim().slice(0, 120),
  };
}

const sameScore = (a, b) => !!a && !!b &&
  Math.round(Number(a.r) * 100) === Math.round(Number(b.r) * 100) &&
  String(a.slug || "") === String(b.slug || "");

function previousScores(previous) {
  const scores = new Map();
  for (const list of Array.isArray(previous?.lists) ? previous.lists : []) {
    for (const item of Array.isArray(list?.items) ? list.items : []) {
      const imdb = carriedImdb(item);
      const score = item?.letterboxd && cleanScore(item.letterboxd.r === 0 ? null : item.letterboxd);
      if (IMDB_RE.test(imdb) && score) scores.set(imdb, score);
    }
  }
  return scores;
}

// Network adapters, replaced in tests.
export const network = {
  async batch(endpoint, ids) {
    const response = await fetch(`${endpoint}?mode=batch&imdb=${ids.join(",")}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`batch ${response.status}`);
    const payload = await response.json();
    return payload?.items && typeof payload.items === "object" ? payload.items : {};
  },
  async single(endpoint, id) {
    const response = await fetch(`${endpoint}?imdb=${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`single ${response.status}`);
    return response.json();
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export async function bakeCatalog(catalog, {
  mapEntries = {},
  previous = null,
  maxLookups = 40,
  spacingMs = 1200,
  log = () => {},
} = {}) {
  const items = (Array.isArray(catalog?.lists) ? catalog.lists : [])
    .flatMap((list) => (Array.isArray(list?.items) ? list.items : []));
  const wanted = new Map();
  for (const item of items) {
    const { imdb, carried } = imdbFor(item, mapEntries);
    if (!imdb) continue;
    if (!carried) item.externalId = { ...(item.externalId || {}), imdb };
    wanted.set(imdb, null);
  }

  const verdicts = new Map();
  const byEndpoint = new Map();
  for (const imdb of wanted.keys()) {
    const endpoint = endpointFor(imdb);
    if (!byEndpoint.has(endpoint)) byEndpoint.set(endpoint, []);
    byEndpoint.get(endpoint).push(imdb);
  }
  for (const [endpoint, ids] of byEndpoint) {
    for (let at = 0; at < ids.length; at += BATCH_MAX) {
      const chunk = ids.slice(at, at + BATCH_MAX);
      try {
        const answered = await network.batch(endpoint, chunk);
        for (const id of chunk) {
          if (!(id in answered)) continue;
          const score = cleanScore(answered[id]);
          if (score) verdicts.set(id, score);
        }
      } catch (error) {
        log(`batch ${new URL(endpoint).hostname}: ${error.message}`);
      }
    }
  }

  let lookups = 0;
  for (const id of wanted.keys()) {
    if (verdicts.has(id)) continue;
    if (lookups >= maxLookups) break;
    if (lookups > 0) await network.sleep(spacingMs);
    lookups += 1;
    try {
      const payload = await network.single(endpointFor(id), id);
      // An unreachable Letterboxd is not a verdict about the film.
      if (payload?.unreachable === true) continue;
      const score = payload?.found ? cleanScore(payload) : (payload?.found === false ? { r: 0 } : undefined);
      if (score) verdicts.set(id, score);
    } catch (error) {
      log(`single ${id}: ${error.message}`);
    }
  }

  const earlier = previousScores(previous);
  const stats = { items: items.length, withImdb: wanted.size, rated: 0, none: 0, unknown: 0, lookups };
  for (const item of items) {
    const imdb = carriedImdb(item);
    if (!IMDB_RE.test(imdb)) {
      delete item.letterboxd;
      continue;
    }
    const fresh = verdicts.get(imdb);
    const kept = earlier.get(imdb);
    // An unchanged score keeps the exact published object, so a count that
    // ticked up does not rewrite the snapshot every hour.
    const score = fresh ? (sameScore(fresh, kept) ? kept : fresh) : kept;
    if (!score) {
      delete item.letterboxd;
      stats.unknown += 1;
      continue;
    }
    item.letterboxd = score;
    if (score.r > 0) stats.rated += 1;
    else stats.none += 1;
  }
  return stats;
}

function argument(name, fallback = "") {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : fallback;
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (fallback !== undefined) return fallback;
    throw error;
  }
}

async function main() {
  const catalogPath = argument("catalog", "curated-fallback.json");
  const catalog = await readJson(catalogPath);
  if (Number(catalog?.schema) !== 1 || !Array.isArray(catalog?.lists)) throw new Error("catalog payload is invalid");
  const map = await readJson(argument("map", "imdb-map.json"), { entries: {} });
  const previous = argument("previous") ? await readJson(argument("previous"), null) : null;
  const stats = await bakeCatalog(catalog, {
    mapEntries: map?.entries || {},
    previous,
    maxLookups: Number(argument("max-lookups", "40")) || 0,
    log: (line) => console.log(line),
  });
  const scores = (value) => JSON.stringify((value?.lists || []).flatMap((list) => (list.items || []).map((item) => [item.key, item.letterboxd || null])));
  catalog.enrichmentVersion = scores(catalog) === scores(previous)
    ? previous?.enrichmentVersion || new Date().toISOString() : new Date().toISOString();
  await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  console.log(`letterboxd: ${stats.rated} rated, ${stats.none} none, ${stats.unknown} unknown ` +
    `of ${stats.withImdb} films with an IMDb id (${stats.items} cards); ${stats.lookups} lookups`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
