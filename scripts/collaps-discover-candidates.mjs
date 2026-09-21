#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { RequestController, SafetyStop } from "./collaps-4k-pipeline.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT_DIR = path.join(ROOT, "var", "collaps-4k-discovery");
const CONFIRM_PHRASE = "COLLAPS_KP_DISCOVERY";
const API_BASE = "https://kinopoiskapiunofficial.tech";
const COLLECTIONS = [
  { type: "TOP_POPULAR_ALL", priority: 100 },
  { type: "TOP_POPULAR_MOVIES", priority: 95 },
  { type: "TOP_250_MOVIES", priority: 85 },
  { type: "TOP_250_TV_SHOWS", priority: 90 },
  { type: "POPULAR_SERIES", priority: 98 },
];

function compact(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function splitSecrets(value) {
  return [...new Set(String(value || "").split(/[\s,;]+/).map((item) => item.trim()).filter(Boolean))];
}

function configuredKeys(env = process.env) {
  return splitSecrets([env.KINOPOISK_UNOFFICIAL_TOKENS, env.KINOPOISK_UNOFFICIAL_TOKEN].filter(Boolean).join(","));
}

function positiveInt(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function validYear(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 1880 && parsed <= new Date().getUTCFullYear() + 2 ? parsed : null;
}

export function normalizeCollectionCandidate(raw, collection, rank) {
  const kpId = String(raw?.kinopoiskId || raw?.filmId || "");
  const title = compact(raw?.nameRu || raw?.nameEn || raw?.nameOriginal);
  if (!/^\d+$/.test(kpId) || !title) return null;
  const type = compact(raw?.type).toUpperCase();
  return {
    key: `kp:${kpId}`,
    kpId,
    title,
    year: validYear(raw?.year),
    isSeries: /TV_SERIES|MINI_SERIES|TV_SHOW/.test(type),
    source: "kinopoisk-collections",
    sourceId: kpId,
    priority: Math.max(1, Number(collection.priority || 0) - Math.floor(rank / 20)),
    collections: [collection.type],
    collectionRanks: { [collection.type]: rank },
  };
}

export function mergeDiscoveredCandidates(pages) {
  const byKp = new Map();
  for (const page of Object.values(pages || {})) {
    for (const candidate of (Array.isArray(page?.items) ? page.items : [])) {
      if (!candidate?.kpId) continue;
      const previous = byKp.get(candidate.kpId);
      if (!previous) {
        byKp.set(candidate.kpId, structuredClone(candidate));
        continue;
      }
      previous.priority = Math.max(previous.priority, candidate.priority);
      previous.collections = [...new Set([...(previous.collections || []), ...(candidate.collections || [])])];
      previous.collectionRanks = { ...(previous.collectionRanks || {}), ...(candidate.collectionRanks || {}) };
      previous.year ||= candidate.year;
      if (!previous.title) previous.title = candidate.title;
      if (previous.isSeries !== candidate.isSeries) previous.isSeries = previous.isSeries || candidate.isSeries;
    }
  }
  return [...byKp.values()].sort((a, b) =>
    b.priority - a.priority ||
    Number(a.isSeries) - Number(b.isSeries) ||
    a.title.localeCompare(b.title, "ru")
  );
}

class KeyPool {
  constructor(keys, controller) {
    this.keys = keys.map((value, index) => ({ value, label: `unofficial#${index + 1}`, disabled: false }));
    this.controller = controller;
    this.cursor = 0;
  }

  async collection(type, page) {
    if (!this.keys.length) throw new SafetyStop("No Kinopoisk Unofficial keys configured", "missing_keys");
    for (let offset = 0; offset < this.keys.length; offset += 1) {
      const index = (this.cursor + offset) % this.keys.length;
      const entry = this.keys[index];
      if (entry.disabled) continue;
      const url = new URL("/api/v2.2/films/collections", API_BASE);
      url.searchParams.set("type", type);
      url.searchParams.set("page", String(page));
      try {
        const data = await this.controller.json(url, {
          label: entry.label,
          retry429: false,
          failOnAuth: false,
          countFailure: false,
          headers: { Accept: "application/json", "X-API-KEY": entry.value },
        });
        this.cursor = (index + 1) % this.keys.length;
        return data;
      } catch (error) {
        if ([401, 402, 403, 429].includes(Number(error?.status || 0))) {
          entry.disabled = true;
          continue;
        }
        throw error;
      }
    }
    throw new SafetyStop("All Kinopoisk Unofficial keys are unavailable or exhausted", "keys_exhausted");
  }
}

function newState(config) {
  const now = new Date().toISOString();
  return {
    schema: 1,
    createdAt: now,
    updatedAt: now,
    collections: config.collections.map((item) => item.type),
    pages: {},
    metrics: { requests: 0, byHost: {} },
    lastRun: null,
  };
}

async function readJson(filePath, optional = false) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (optional && error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeAtomic(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  await fs.writeFile(temp, text, { mode: 0o600 });
  await fs.rename(temp, filePath);
}

async function acquireLock(config) {
  const lockPath = path.join(config.outDir, ".lock");
  let handle;
  try {
    handle = await fs.open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") throw new SafetyStop(`Lock exists at ${lockPath}`, "lock_exists");
    throw error;
  }
  await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + "\n");
  await handle.close();
  return async () => fs.unlink(lockPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
}

function collectionByType(config, type) {
  return config.collections.find((item) => item.type === type);
}

async function exportCandidates(state, config) {
  const candidates = mergeDiscoveredCandidates(state.pages);
  const movies = candidates.filter((item) => !item.isSeries).length;
  const series = candidates.length - movies;
  const body = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    source: "kinopoisk-collections",
    collections: state.collections,
    counts: { total: candidates.length, movies, series },
    candidates,
  };
  await writeAtomic(config.outputPath, JSON.stringify(body, null, 2) + "\n");
  await writeAtomic(config.summaryPath, JSON.stringify({
    generatedAt: body.generatedAt,
    ...body.counts,
    pages: Object.keys(state.pages || {}).length,
    requests: state.metrics?.requests || 0,
    byHost: state.metrics?.byHost || {},
  }, null, 2) + "\n");
  return { ...body.counts, pages: Object.keys(state.pages || {}).length, output: config.outputPath };
}

function status(state, config) {
  const candidates = mergeDiscoveredCandidates(state.pages);
  return {
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    lastRun: state.lastRun,
    pages: Object.keys(state.pages || {}).length,
    candidates: candidates.length,
    movies: candidates.filter((item) => !item.isSeries).length,
    series: candidates.filter((item) => item.isSeries).length,
    requests: state.metrics?.requests || 0,
    output: config.outputPath,
  };
}

export async function runDiscovery(config, dependencies = {}) {
  if (config.command === "run" && config.confirm !== CONFIRM_PHRASE) {
    throw new SafetyStop(`Network discovery refused. Add --confirm ${CONFIRM_PHRASE}`, "confirmation_required");
  }
  const state = config.refresh ? newState(config) : (await readJson(config.statePath, true) || newState(config));
  if (state.schema !== 1) throw new Error(`Unsupported state schema ${state.schema}`);
  state.pages ||= {};
  state.metrics ||= { requests: 0, byHost: {} };
  if (config.command === "plan") {
    return {
      mode: "offline-plan",
      networkStarted: false,
      collections: config.collections.map((item) => item.type),
      maximumPages: config.collections.length * config.maxPagesPerCollection,
      pacingMs: [config.minDelayMs, config.maxDelayMs],
      requestBudget: config.maxRequests,
    };
  }
  if (config.command === "status") return status(state, config);
  if (config.command === "export") return exportCandidates(state, config);

  await fs.mkdir(config.outDir, { recursive: true });
  const releaseLock = await acquireLock(config);
  const checkpoint = async () => {
    state.updatedAt = new Date().toISOString();
    await writeAtomic(config.statePath, JSON.stringify(state, null, 2) + "\n");
  };
  const controller = new RequestController(config, state, dependencies);
  const pool = new KeyPool(configuredKeys(dependencies.env || process.env), controller);
  const onInterrupt = () => controller.stop();
  if (dependencies.handleSignals !== false) {
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onInterrupt);
  }
  try {
    state.lastRun = { startedAt: new Date().toISOString(), status: "running" };
    await checkpoint();
    for (const collection of config.collections) {
      let page = 1;
      let totalPages = config.maxPagesPerCollection;
      while (page <= Math.min(totalPages, config.maxPagesPerCollection)) {
        const key = `${collection.type}:${page}`;
        const previous = state.pages[key];
        if (previous) {
          totalPages = positiveInt(previous.totalPages) || totalPages;
          page += 1;
          continue;
        }
        const raw = await pool.collection(collection.type, page);
        totalPages = Math.min(positiveInt(raw?.totalPages) || page, config.maxPagesPerCollection);
        const items = (Array.isArray(raw?.items) ? raw.items : [])
          .map((item, index) => normalizeCollectionCandidate(item, collection, (page - 1) * 20 + index + 1))
          .filter(Boolean);
        state.pages[key] = {
          type: collection.type,
          page,
          totalPages,
          total: positiveInt(raw?.total) || null,
          items,
          completedAt: new Date().toISOString(),
        };
        process.stderr.write(`[discover] ${collection.type} ${page}/${totalPages}: ${items.length}\n`);
        await checkpoint();
        await exportCandidates(state, config);
        page += 1;
      }
    }
    state.lastRun = { ...state.lastRun, status: "complete", finishedAt: new Date().toISOString(), requests: controller.requestsThisRun };
    await checkpoint();
    return exportCandidates(state, config);
  } catch (error) {
    state.lastRun = {
      ...state.lastRun,
      status: error instanceof SafetyStop ? "stopped" : "failed",
      finishedAt: new Date().toISOString(),
      code: error?.code || null,
      message: compact(error?.message || error).slice(0, 240),
      requests: controller.requestsThisRun,
    };
    await checkpoint().catch(() => {});
    await exportCandidates(state, config).catch(() => {});
    throw error;
  } finally {
    if (dependencies.handleSignals !== false) {
      process.removeListener("SIGINT", onInterrupt);
      process.removeListener("SIGTERM", onInterrupt);
    }
    await releaseLock().catch(() => {});
  }
}

function optionMap(argv) {
  const out = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) { out._.push(token); continue; }
    const equal = token.indexOf("=");
    if (equal !== -1) { out[token.slice(2, equal)] = token.slice(equal + 1); continue; }
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) { out[name] = next; index += 1; }
    else out[name] = true;
  }
  return out;
}

function numberOption(value, fallback, name, min, max) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`Invalid --${name}: ${value}`);
  return parsed;
}

export function parseDiscoveryConfig(argv = process.argv.slice(2)) {
  const args = optionMap(argv);
  const command = args._[0] || "plan";
  if (!new Set(["plan", "run", "status", "export"]).has(command)) throw new Error(`Unknown command ${command}`);
  if (args._.length > 1) throw new Error(`Unexpected argument(s): ${args._.slice(1).join(", ")}`);
  const known = new Set(["collections", "confirm", "max-delay-ms", "max-pages", "max-requests", "min-delay-ms", "out-dir", "refresh", "retries", "timeout-ms"]);
  const unknown = Object.keys(args).filter((key) => key !== "_" && !known.has(key));
  if (unknown.length) throw new Error(`Unknown option(s): ${unknown.map((key) => `--${key}`).join(", ")}`);
  const selectedTypes = String(args.collections || COLLECTIONS.map((item) => item.type).join(","))
    .split(",").map((item) => item.trim()).filter(Boolean);
  const collections = selectedTypes.map((type) => collectionByType({ collections: COLLECTIONS }, type)).filter(Boolean);
  if (collections.length !== selectedTypes.length) throw new Error("Invalid --collections value");
  const outDir = path.resolve(args["out-dir"] || DEFAULT_OUT_DIR);
  const minDelayMs = numberOption(args["min-delay-ms"], 300, "min-delay-ms", 250, 10000);
  return {
    command,
    confirm: compact(args.confirm),
    collections,
    outDir,
    statePath: path.join(outDir, "state.json"),
    outputPath: path.join(outDir, "candidates.json"),
    summaryPath: path.join(outDir, "summary.json"),
    minDelayMs,
    maxDelayMs: numberOption(args["max-delay-ms"], 700, "max-delay-ms", minDelayMs, 30000),
    maxPagesPerCollection: numberOption(args["max-pages"], 50, "max-pages", 1, 50),
    maxRequests: numberOption(args["max-requests"], 200, "max-requests", 1, 1000),
    timeoutMs: numberOption(args["timeout-ms"], 15000, "timeout-ms", 1000, 60000),
    retries: numberOption(args.retries, 2, "retries", 0, 5),
    maxConsecutiveFailures: 5,
    refresh: !!args.refresh,
  };
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`Kinopoisk batch candidate discovery\n\n` +
      `Offline: node scripts/collaps-discover-candidates.mjs plan|status|export\n` +
      `Network: node scripts/collaps-discover-candidates.mjs run --confirm ${CONFIRM_PHRASE}\n`);
    return;
  }
  const result = await runDiscovery(parseDiscoveryConfig(argv));
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof SafetyStop ? "STOPPED" : "FAILED"}: ${error.message}\n`);
    process.exitCode = error instanceof SafetyStop ? 2 : 1;
  });
}
