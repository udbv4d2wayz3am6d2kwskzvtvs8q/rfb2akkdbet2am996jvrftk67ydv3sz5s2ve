#!/usr/bin/env node
// Bounded warming of the real external recommendation graph. No local ranking.
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { hostFor, replicaFor, objectPath } from "../supabase/functions/kp/index.ts";
export function createPrewarmReader({ token, maxFills = 120, deadline = Date.now() + 15 * 60e3,
  fetcher = fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now, log = console.log }) {
  const stats = { fills: 0, retries: 0, deferred: 0 };
  async function get(kind, id) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (now() >= deadline) throw new Error("prewarm time budget reached; remaining objects wait for next run");
      // After an ambiguous timeout, check the published result before asking
      // the broker again. Every broker attempt counts towards the run budget.
      for (const host of [hostFor(id), replicaFor(id)]) {
        try {
          const r = await fetcher(`https://${host}.supabase.co/storage/v1/object/public/kp/${objectPath(kind, id)}`, { signal: AbortSignal.timeout(5000) });
          if (r.ok) {
            const object = await r.json();
            if (object.kind === kind && String(object.id) === id && Date.parse(object.freshUntil) > now()) return object.data;
          }
        } catch { /* replica */ }
      }
      if (stats.fills >= maxFills) return null;
      stats.fills += 1;
      let failure;
      try {
        const r = await fetcher(`https://xoathqkggcuyoyutxwri.supabase.co/functions/v1/kp?kind=${kind}&id=${id}`, {
          headers: { "x-kp-token": token }, signal: AbortSignal.timeout(20000),
        });
        const body = await r.json();
        if (["budget_exhausted", "keys_refused", "no_keys"].includes(body.error)) {
          const error = new Error("shared quota or keys unavailable; stop prewarming");
          error.fatal = true; throw error;
        }
        if ([401, 403].includes(r.status)) {
          const error = new Error(`prewarm authorization failed: ${r.status}`);
          error.fatal = true; throw error;
        }
        if (r.status === 202 || body.error === "backing_off") { stats.deferred += 1; return null; }
        if (r.ok) return body.data || null;
        failure = `${r.status} ${body.error || "upstream error"}`;
      } catch (error) {
        if (error.fatal) throw error;
        // Do not log request objects or headers containing the broker token.
        failure = error.name || "network error";
      }
      if (attempt === 2) throw new Error(`prewarm failed after 3 attempts: ${kind}/${id} ${failure}`);
      stats.retries += 1;
      log(`prewarm retry ${attempt + 1}: ${kind}/${id} ${failure}`);
      await sleep((attempt + 1) * 2000);
    }
  }
  return { get, stats };
}

async function main() {
const token = process.env.KP_BROKER_TOKEN;
if (!token) throw new Error("KP_BROKER_TOKEN required");
const catalog = JSON.parse(await readFile(process.argv[2] || "curated-fallback.json", "utf8"));
const seeds = [...new Set(catalog.lists.flatMap((list) => list.items || []).map((item) => String(item.target?.kpId || item.kpId || "")).filter((id) => /^[1-9]\d*$/.test(id)))];
const maxFills = Math.max(1, Math.min(500, Number(process.env.KP_PREWARM_MAX || 120)));
const { get, stats } = createPrewarmReader({ token, maxFills });
const candidates = new Set();
for (const id of seeds) {
  for (const kind of ["film", "staff", "similars"]) {
    const value = await get(kind, id);
    if (kind === "similars") for (const item of value?.items || []) {
      const next = String(item.filmId || item.kinopoiskId || "");
      if (/^[1-9]\d*$/.test(next)) candidates.add(next);
    }
  }
}
for (const id of candidates) await get("film", id);
console.log(`prewarm: ${seeds.length} seeds, ${candidates.size} external candidates, ${stats.fills}/${maxFills} fills, ${stats.retries} retries, ${stats.deferred} deferred`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) await main();
