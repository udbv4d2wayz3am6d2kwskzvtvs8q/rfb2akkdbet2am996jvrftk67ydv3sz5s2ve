#!/usr/bin/env node
// Keeps the title index in step with the source, from a scheduled GitHub job.
//
// The Cloudflare crawler read the catalogue once and then stopped for good —
// `catalog_done_at` is never cleared — so every title listed since was missing
// from search (the source had 81,953, the index 81,702). It also runs on a plan
// that kills an invocation after 10 ms of CPU. This job runs every two hours:
//
//  - the first pages of the listing, which is newest first (by year, then
//    release), until three pages in a row bring nothing new — a new release is
//    in search within two hours;
//  - every four hours, the whole listing, including episode revision markers;
//  - then the titles still missing their player or Kinopoisk id, newest first.
//
// How it treats the source is unchanged from the crawler it replaces: one
// request at a time, two seconds apart, a User-Agent that says who we are, and
// any 429 ends the run rather than retrying into it. Only new or changed rows
// are written (titles_upsert_catalog), so a daily full read costs the database
// nothing for a title that did not change.
//
//   PUBLISH_TOKEN=… node scripts/sync-titles.mjs [--full] [--fill 300] [--budget-min 45]
import { pathToFileURL } from "node:url";

export const UA = "AlphyTVIndexer/1.0 (+https://alphy.tv; contact: info@alphy.tv)";
const CATALOG = "https://api.zombie-film.live/v2/franchise/search/";
const VIEW = "https://api.zombie-film.live/v2/franchise/view/";
const TITLES_URL = process.env.TITLES_URL || "https://xoathqkggcuyoyutxwri.supabase.co/functions/v1/titles";
export const SPACING_MS = 2000;
const PER_PAGE = 100;
const HEAD_MIN_PAGES = 3;
const HEAD_QUIET_PAGES = 3;
const HEAD_MAX_PAGES = 40;
const FILL_BATCH = 25;
const SOFT_STREAK_LIMIT = 5;

export class SoftError extends Error {}

export const net = {
  token: process.env.PUBLISH_TOKEN || "",
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  async source(url, { soft = false } = {}) {
    const response = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    // 429 is always about us, never about the row: the run ends here.
    if (response.status === 429) throw new Error("429 rate limited");
    if (!response.ok) {
      if (soft) throw new SoftError(`http ${response.status}`);
      throw new Error(`http ${response.status}`);
    }
    return response.json();
  },
  async titles(route, body) {
    // Reads and catalogue upserts can safely repeat after an ambiguous timeout.
    // /fill increments failure counters and /build mutates a queue: do not
    // automatically replay those writes.
    const attempts = body === undefined || route === "/catalog" || route === "/sync-state" ? 3 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
    let response;
    try { response = await fetch(`${TITLES_URL}${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "x-publish-token": net.token, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    }); } catch (error) {
      if (attempt + 1 === attempts) throw error;
      console.log(`titles retry ${attempt + 1}: ${route} network error`);
      await net.sleep(2000 * (attempt + 1)); continue;
    }
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 200);
      if ([502, 503, 504].includes(response.status) && attempt + 1 < attempts) {
        console.log(`titles retry ${attempt + 1}: ${route} ${response.status}`);
        await net.sleep(2000 * (attempt + 1)); continue;
      }
      throw new Error(`titles ${route} ${response.status} ${detail}`);
    }
    return response.json();
    }
  },
};

export function catalogRow(item) {
  return {
    id: Number(item?.id),
    name: String(item?.name || "").trim(),
    year: Number(item?.year) || null,
    type: Number(item?.type) || null,
    slug: String(item?.slug || ""),
    rate_kp: Number(item?.rate?.kinopoisk) || null,
    // Compact source revision; no additional fields are exposed in the UI.
    source_revision: JSON.stringify([item?.seasonLast?.season ?? null, item?.episodeLast?.episode ?? null,
      item?.finished ?? null, item?.quality ?? null, item?.status ?? null]),
  };
}

export async function syncCatalog({ full = false, deadline = Infinity, startPage = 1, checkpoint = null } = {}) {
  const stats = { pages: 0, inserted: 0, updated: 0, total: 0, reachedEnd: false, nextPage: startPage };
  let lastFirst = "";
  let quiet = 0;
  try { for (let page = startPage; net.now() < deadline; page += 1) {
    if (page > startPage) await net.sleep(SPACING_MS);
    const query = new URLSearchParams({
      findBy: "filter", all: "false", page: String(page), "per-page": String(PER_PAGE), _format: "json",
    });
    const payload = await net.source(`${CATALOG}?${query}`);
    const items = Array.isArray(payload?.items) ? payload.items : [];
    const total = Number(payload?.totalCount) || 0;
    if (total) stats.total = total;
    // The end does not look like an empty page: the API serves the last page
    // again for any page past it, forever.
    const first = String(items[0]?.id ?? "");
    if (!items.length || first === lastFirst || (total && (page - 1) * PER_PAGE >= total)) {
      stats.reachedEnd = true;
      break;
    }
    lastFirst = first;
    const rows = items.map(catalogRow).filter((row) => Number.isInteger(row.id) && row.id > 0 && row.name);
    const result = await net.titles("/catalog", rows);
    stats.pages += 1;
    stats.inserted += Number(result?.inserted) || 0;
    stats.updated += Number(result?.updated) || 0;
    stats.nextPage = page + 1;
    if (full && checkpoint && stats.pages % 25 === 0) await checkpoint(Math.max(1, stats.nextPage - 2));
    if (full) continue;
    quiet = (Number(result?.inserted) || 0) + (Number(result?.updated) || 0) ? 0 : quiet + 1;
    if ((page >= HEAD_MIN_PAGES && quiet >= HEAD_QUIET_PAGES) || page >= HEAD_MAX_PAGES) break;
  } } finally {
    if (full && checkpoint && !stats.reachedEnd) await checkpoint(Math.max(1, stats.nextPage - 2));
  }
  return stats;
}

export async function titleView(slug) {
  const ask = (season) => net.source(`${VIEW}?${new URLSearchParams({
    slug, findBy: "init", all: "false", season, _format: "json",
  })}`, { soft: true });
  let payload = await ask("");
  // A series answers video:null until a season is named.
  if (!payload?.view?.video) {
    await net.sleep(SPACING_MS);
    const season = await ask("1");
    // Some series have metadata but no first-season page yet. Keep the valid
    // initial response; an empty optional season is not an upstream outage.
    if (season?.view && Object.keys(season.view).length) {
      payload = { view: { ...payload?.view, ...season.view } };
    }
  }
  if (!payload?.view || typeof payload.view !== "object" || !Object.keys(payload.view).length) throw new SoftError("empty title view");
  return payload.view;
}

export function fillRow(id, view) {
  // "" rather than null records a confirmed absence; the due queue retries it.
  const raw = String(view?.kpId ?? "");
  const kp = /^\d+$/.test(raw) && raw !== "0" ? raw : "";
  const embed = Number(String(view?.video?.embedUrl || "").match(/\/(\d+)/)?.[1]) || null;
  return {
    id,
    kp,
    embed_id: embed,
    origin_name: String(view?.originName || ""),
    is_series: !!(view?.season || view?.seasonLast) || [3, 4, 5].includes(Number(view?.type)),
  };
}

export async function fullScanDue(state = null) {
  state ||= await net.titles("/sync-state");
  const last = Date.parse(state?.last_full_at);
  return !!state?.full_started_at || Number(state?.next_full_page) > 1 || !Number.isFinite(last) || net.now() - last >= 4 * 3600e3;
}

export async function fillPending({ limit = 300, deadline = Infinity } = {}) {
  const { rows } = await net.titles(`/pending?limit=${limit}`);
  const stats = { asked: 0, filled: 0, failed: 0, stoppedBy: "" };
  let batch = [];
  let softStreak = 0;
  const flush = async () => {
    if (!batch.length) return;
    await net.titles("/fill", batch);
    batch = [];
  };
  try {
    for (const row of rows || []) {
      if (net.now() >= deadline) {
        stats.stoppedBy = "budget";
        break;
      }
      if (stats.asked > 0) await net.sleep(SPACING_MS);
      stats.asked += 1;
      try {
        batch.push(fillRow(row.id, await titleView(row.slug)));
        stats.filled += 1;
        softStreak = 0;
      } catch (error) {
        if (!(error instanceof SoftError)) {
          stats.stoppedBy = error.message;
          break;
        }
        batch.push({ id: row.id, failed: true });
        stats.failed += 1;
        console.log(`fill failed: id=${row.id} slug=${row.slug} reason=${error.message}`);
        // Scattered bad rows are normal; a run of them means the source is unhappy.
        if (++softStreak >= SOFT_STREAK_LIMIT) {
          stats.stoppedBy = "five failures in a row";
          break;
        }
      }
      if (batch.length >= FILL_BATCH) await flush();
    }
  } finally {
    await flush();
  }
  return stats;
}

export async function buildFallback({ deadline = Infinity, maxCalls = 25 } = {}) {
  let built = 0;
  for (let i = 0; i < maxCalls && net.now() < deadline; i += 1) {
    const result = await net.titles("/build?max=6", {});
    built += result.built?.length || 0;
    if (result.failed?.length) throw new Error(`fallback build failed: ${result.failed.join(",")}`);
    if (!result.remaining || !result.built?.length) return { built, remaining: result.remaining || 0 };
  }
  throw new Error("fallback build did not drain before budget");
}

function argument(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : fallback;
}

export async function runSync({ forceFull = false, auto = true, budgetMin = 45, fillLimit = 300 } = {}) {
  if (!net.token) throw new Error("PUBLISH_TOKEN is required");
  budgetMin = Math.max(1, Math.min(45, Number(budgetMin) || 45));
  fillLimit = Math.max(1, Math.min(300, Number(fillLimit) || 300));
  const state = auto ? await net.titles("/sync-state") : {};
  const full = forceFull || (auto && await fullScanDue(state));
  const budgetMs = budgetMin * 60e3;
  const deadline = net.now() + budgetMs;
  const catalogDeadline = deadline - Math.min(15 * 60e3, budgetMs / 3);
  const startPage = full && !forceFull ? Math.max(1, Number(state.next_full_page) || 1) : 1;
  const started = new Date(forceFull ? net.now() : (state.full_started_at || net.now())).toISOString();
  if (full && startPage > 1) await syncCatalog({ deadline: Math.min(catalogDeadline, net.now() + 5 * 60e3) });
  const catalog = await syncCatalog({ full, startPage, deadline: catalogDeadline,
    checkpoint: full ? (page) => net.titles("/sync-state", { next_full_page: page, full_started_at: started }) : null });
  // Freshness starts when the scan starts, not when a slow scan finally ends.
  if (full && catalog.reachedEnd) await net.titles("/sync-state", { completed: true, full_started_at: started });
  console.log(`catalogue: ${catalog.pages} pages, ${catalog.inserted} new, ${catalog.updated} changed` +
    ` (source lists ${catalog.total}${full ? `, full read ${catalog.reachedEnd ? "complete" : "cut short"}` : ""})`);
  const fill = await fillPending({ limit: fillLimit, deadline });
  console.log(`fill: ${fill.filled} resolved, ${fill.failed} failed of ${fill.asked} asked` +
    (fill.stoppedBy ? `; stopped: ${fill.stoppedBy}` : ""));
  // Separate budget so a full catalogue read cannot starve the fallback build.
  console.log("fallback:", await buildFallback({ deadline: net.now() + 5 * 60e3 }));
  if (full && !catalog.reachedEnd) console.log(`full scan checkpoint saved near page ${catalog.nextPage}; next run continues`);
  if (fill.stoppedBy && fill.stoppedBy !== "budget") throw new Error(`fill stopped: ${fill.stoppedBy}`);
  return { catalog, fill };
}

async function main() {
  return runSync({ forceFull: process.argv.includes("--full"), auto: process.argv.includes("--auto"),
    budgetMin: Number(argument("budget-min", "45")), fillLimit: Number(argument("fill", "300")) });
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
