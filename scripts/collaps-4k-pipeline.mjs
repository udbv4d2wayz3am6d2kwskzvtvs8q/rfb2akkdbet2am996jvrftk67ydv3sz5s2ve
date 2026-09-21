#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT_DIR = path.join(ROOT, "var", "collaps-4k");
const COLLAPS_BASE = "https://plapi.cdnvideohub.com/api/v1/player/sv";
const CONFIRM_PHRASE = "COLLAPS_4K_SCAN";
const GENERIC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";
const VIDEO_MISS_STATUSES = new Set([400, 404, 410, 422]);

export const QUALITY_FIELDS = [
  // CDNVideoHub type=7 is the 3840-wide rendition; type=6 is 2560-wide.
  ["mpeg2kUrl", "4K", 2160],
  ["mpeg4kUrl", "2K", 1440],
  ["mpegQhdUrl", "1440p", 1440],
  ["mpegFullHdUrl", "1080p", 1080],
  ["mpegHighUrl", "720p", 720],
  ["mpegMediumUrl", "480p", 480],
  ["mpegLowUrl", "360p", 360],
  ["mpegLowestUrl", "240p", 240],
  ["mpegTinyUrl", "144p", 144],
];

export class SafetyStop extends Error {
  constructor(message, code = "safety_stop") {
    super(message);
    this.name = "SafetyStop";
    this.code = code;
  }
}

class HttpError extends Error {
  constructor(status, message, retryAfterMs = 0) {
    super(message || `HTTP ${status}`);
    this.name = "HttpError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function compact(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function cleanDisplayTitle(value) {
  const title = compact(value);
  const openCount = (title.match(/\(/g) || []).length;
  const closeCount = (title.match(/\)/g) || []).length;
  return openCount === closeCount + 1 && /\(\d{4}$/.test(title) ? `${title})` : title;
}

function positiveInt(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function validYear(value) {
  const parsed = Number.parseInt(value, 10);
  const max = new Date().getUTCFullYear() + 2;
  return Number.isFinite(parsed) && parsed >= 1880 && parsed <= max ? parsed : null;
}

export function normalizeTitle(value) {
  return compact(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/&/g, " and ")
    .replace(/[’'`]/g, "")
    .replace(/[^a-zа-я0-9]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function candidateKey(value, fallbackIndex = 0) {
  if (value.key) return compact(value.key);
  if (value.source && value.sourceId != null) return `${value.source}:${value.sourceId}`;
  if (/^\d+$/.test(String(value.kpId || ""))) return `kp:${value.kpId}`;
  return `input:${normalizeTitle(value.title)}:${value.year || "?"}:${value.isSeries ? "series" : "movie"}:${fallbackIndex}`;
}

function normalizeCandidate(value, fallbackIndex = 0) {
  const title = compact(value.title || value.t || value.name);
  if (!title) return null;
  const kpId = /^\d+$/.test(String(value.kpId || value.kinopoiskId || ""))
    ? String(value.kpId || value.kinopoiskId)
    : null;
  const source = compact(value.source || "input");
  const sourceId = compact(value.sourceId ?? value.id ?? "") || null;
  const isSeries = typeof value.isSeries === "boolean" ? value.isSeries : null;
  const candidate = {
    key: "",
    title,
    year: validYear(value.year),
    isSeries,
    kpId,
    source,
    sourceId,
    priority: Number.isFinite(Number(value.priority)) ? Number(value.priority) : 0,
  };
  candidate.key = candidateKey({ ...candidate, key: value.key }, fallbackIndex);
  return candidate;
}

export async function loadSoapCandidates(filePath) {
  const data = await readJson(filePath);
  const movies = Array.isArray(data) ? data : (Array.isArray(data?.movies) ? data.movies : []);
  return movies
    .filter((movie) => movie?.q === "4K" || Number(movie?.w || 0) > 1920 || Number(movie?.h || 0) > 1080)
    .map((movie, index) => normalizeCandidate({
      key: `soap:${movie.id}`,
      source: "soap",
      sourceId: movie.id,
      title: movie.t,
      // Old SOAP dumps inferred years from the title itself (e.g. Blade Runner
      // 2049), so they are intentionally not trusted for automatic KP matching.
      year: null,
      isSeries: false,
      priority: 100,
    }, index))
    .filter(Boolean);
}

export async function loadCuratedCandidates(filePath) {
  const data = await readJson(filePath);
  const out = [];
  for (const list of (Array.isArray(data?.lists) ? data.lists : [])) {
    for (const item of (Array.isArray(list?.items) ? list.items : [])) {
      const target = item?.target || {};
      const rawKp = target.kpId ?? item.kpId;
      if (!/^\d+$/.test(String(rawKp || ""))) continue;
      const candidate = normalizeCandidate({
        key: `kp:${rawKp}`,
        source: "curated",
        sourceId: item.id || item.key,
        title: item.title,
        year: item.year,
        isSeries: !!item.isSeries,
        kpId: String(rawKp),
        priority: 70,
      }, out.length);
      if (candidate) out.push(candidate);
    }
  }
  return out;
}

export async function loadInputCandidates(filePath) {
  const data = await readJson(filePath);
  const rows = Array.isArray(data) ? data : (Array.isArray(data?.candidates) ? data.candidates : []);
  return rows.map((item, index) => normalizeCandidate(item, index)).filter(Boolean);
}

export function mergeCandidates(values) {
  const byKey = new Map();
  const kpToKey = new Map();
  for (const candidate of values.filter(Boolean)) {
    const key = candidate.kpId && kpToKey.has(candidate.kpId)
      ? kpToKey.get(candidate.kpId)
      : candidate.key;
    const previous = byKey.get(key);
    if (!previous) {
      byKey.set(key, { ...candidate, sources: [candidate.source] });
      if (candidate.kpId) kpToKey.set(candidate.kpId, key);
      continue;
    }
    previous.priority = Math.max(previous.priority, candidate.priority);
    previous.sources = [...new Set([...previous.sources, candidate.source])];
    previous.year ||= candidate.year;
    previous.kpId ||= candidate.kpId;
    if (previous.isSeries == null) previous.isSeries = candidate.isSeries;
  }
  return [...byKey.values()].sort((a, b) => b.priority - a.priority || a.title.localeCompare(b.title, "ru"));
}

function normalizeSearchHit(item, provider) {
  if (provider === "poiskkino") {
    return {
      kpId: String(item?.id || item?.kpId || ""),
      names: [item?.name, item?.alternativeName, item?.enName].map(compact).filter(Boolean),
      year: validYear(item?.year),
      isSeries: typeof item?.isSeries === "boolean" ? item.isSeries : /series|tv/i.test(String(item?.type || "")),
      raw: item,
    };
  }
  return {
    kpId: String(item?.filmId || item?.kinopoiskId || ""),
    names: [item?.nameRu, item?.nameEn, item?.nameOriginal].map(compact).filter(Boolean),
    year: validYear(String(item?.year || "").match(/\d{4}/)?.[0]),
    isSeries: /SERIES|TV_SHOW|MINI/i.test(String(item?.type || "")),
    raw: item,
  };
}

export function matchKinopoiskCandidate(candidate, rawHits, provider = "unofficial") {
  const wanted = normalizeTitle(candidate.title);
  const hits = rawHits
    .map((item) => normalizeSearchHit(item, provider))
    .filter((item) => /^\d+$/.test(item.kpId));
  const exact = hits.filter((item) => item.names.some((name) => normalizeTitle(name) === wanted));
  const typed = candidate.isSeries == null ? exact : exact.filter((item) => item.isSeries === candidate.isSeries);
  let narrowed = typed;
  if (candidate.year) {
    const near = typed.filter((item) => item.year && Math.abs(item.year - candidate.year) <= 1);
    if (near.length) narrowed = near;
  }
  if (narrowed.length === 1) {
    return {
      status: "mapped",
      kpId: narrowed[0].kpId,
      year: narrowed[0].year,
      isSeries: narrowed[0].isSeries,
      confidence: candidate.year ? "exact_title_type_year" : "exact_title_type",
      matchedName: narrowed[0].names[0] || candidate.title,
    };
  }
  return {
    status: narrowed.length > 1 ? "ambiguous" : "not_found",
    reason: narrowed.length > 1 ? "multiple_exact_matches" : (exact.length ? "type_or_year_mismatch" : "no_exact_title"),
    suggestions: (narrowed.length ? narrowed : exact).slice(0, 8).map((item) => ({
      kpId: item.kpId,
      title: item.names[0] || "",
      aliases: item.names.slice(1),
      year: item.year,
      isSeries: item.isSeries,
    })),
  };
}

export function bestQuality(sources) {
  for (const [key, label, height] of QUALITY_FIELDS) {
    if (/^https:\/\//i.test(compact(sources?.[key]))) return { key, label, height };
  }
  return null;
}

function sanitizePlaylist(data) {
  const seen = new Set();
  const items = [];
  for (const raw of (Array.isArray(data?.items) ? data.items : [])) {
    const vkId = compact(raw?.vkId || raw?.videoId || raw?.id);
    if (!vkId || seen.has(vkId)) continue;
    seen.add(vkId);
    items.push({
      vkId,
      season: positiveInt(raw?.season),
      episode: positiveInt(raw?.episode),
      voiceStudio: compact(raw?.voiceStudio || raw?.translation || raw?.voice),
      voiceType: compact(raw?.voiceType),
      name: compact(raw?.name || raw?.title),
    });
  }
  return {
    titleName: compact(data?.titleName || data?.title),
    isSeries: !!data?.isSerial || items.some((item) => item.season || item.episode),
    items,
  };
}

function evenlySpaced(values, count) {
  if (values.length <= count) return [...values];
  if (count <= 1) return [values[0]];
  const picked = new Set();
  for (let index = 0; index < count; index += 1) {
    picked.add(values[Math.round(index * (values.length - 1) / (count - 1))]);
  }
  return [...picked];
}

export function buildProbeQueue(items, options = {}) {
  const unique = [];
  const seen = new Set();
  for (const item of (Array.isArray(items) ? items : [])) {
    if (!item?.vkId || seen.has(item.vkId)) continue;
    seen.add(item.vkId);
    unique.push(item);
  }
  const isSeries = !!options.isSeries;
  const mode = options.seriesMode || "staged";
  if (!isSeries) {
    const limit = Math.max(1, Number(options.maxFilmVideos || 12));
    return { queue: unique.slice(0, limit), complete: unique.length <= limit, totalUnique: unique.length, sampledEpisodes: 0 };
  }
  if (mode === "skip") return { queue: [], complete: false, totalUnique: unique.length, sampledEpisodes: 0 };
  if (mode === "full") return { queue: unique, complete: true, totalUnique: unique.length, sampledEpisodes: unique.length };

  const bySeason = new Map();
  for (const item of unique) {
    const season = item.season || 0;
    const episode = item.episode || 0;
    if (!bySeason.has(season)) bySeason.set(season, new Map());
    const episodes = bySeason.get(season);
    if (!episodes.has(episode)) episodes.set(episode, []);
    episodes.get(episode).push(item);
  }
  const samplesPerSeason = Math.max(1, Number(options.seriesSamples || 3));
  const voicesPerEpisode = Math.max(1, Number(options.voicesPerEpisode || 2));
  const maxVideos = Math.max(1, Number(options.maxSeriesVideos || 48));
  const queue = [];
  let sampledEpisodes = 0;
  const seasons = [...bySeason.keys()].sort((a, b) => a - b);
  const selectedSeasons = mode === "quick"
    ? evenlySpaced(seasons, Math.max(1, Number(options.seriesSeasonSamples || 3)))
    : seasons;
  for (const season of selectedSeasons) {
    const episodes = bySeason.get(season);
    const episodeNumbers = [...episodes.keys()].sort((a, b) => a - b);
    for (const episode of evenlySpaced(episodeNumbers, samplesPerSeason)) {
      sampledEpisodes += 1;
      queue.push(...episodes.get(episode).slice(0, voicesPerEpisode));
      if (queue.length >= maxVideos) break;
    }
    if (queue.length >= maxVideos) break;
  }
  const limited = queue.slice(0, maxVideos);
  return {
    queue: limited,
    complete: limited.length === unique.length,
    totalUnique: unique.length,
    sampledEpisodes,
  };
}

function splitSecrets(value) {
  return [...new Set(String(value || "").split(/[\s,;]+/).map((item) => item.trim()).filter(Boolean))];
}

function providerKeys(provider, env = process.env) {
  if (provider === "poiskkino") {
    return splitSecrets([env.POISKKINO_TOKENS, env.POISKKINO_TOKEN].filter(Boolean).join(","));
  }
  if (provider === "unofficial") {
    return splitSecrets([env.KINOPOISK_UNOFFICIAL_TOKENS, env.KINOPOISK_UNOFFICIAL_TOKEN].filter(Boolean).join(","));
  }
  return [];
}

function retryAfterMs(response) {
  const value = response.headers.get("retry-after");
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

function randomBetween(min, max, random = Math.random) {
  return Math.round(min + random() * Math.max(0, max - min));
}

export class RequestController {
  constructor(config, state, dependencies = {}) {
    this.config = config;
    this.state = state;
    this.fetchImpl = dependencies.fetchImpl || globalThis.fetch;
    this.sleep = dependencies.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = dependencies.random || Math.random;
    this.now = dependencies.now || (() => Date.now());
    this.lastRequestAt = 0;
    this.requestsThisRun = 0;
    this.consecutiveFailures = 0;
    this.stopRequested = false;
    this.activeController = null;
  }

  stop() {
    this.stopRequested = true;
    this.activeController?.abort();
  }

  async pace(extraMs = 0) {
    const delay = Math.max(extraMs, randomBetween(this.config.minDelayMs, this.config.maxDelayMs, this.random));
    const wait = Math.max(0, this.lastRequestAt + delay - this.now());
    if (wait) await this.sleep(wait);
  }

  async json(url, options = {}) {
    const attempts = Math.max(1, Number(options.attempts || this.config.retries + 1));
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (this.stopRequested) throw new SafetyStop("Interrupted; checkpoint preserved", "interrupted");
      if (this.requestsThisRun >= this.config.maxRequests) {
        throw new SafetyStop(`Request budget ${this.config.maxRequests} exhausted`, "request_budget");
      }
      await this.pace(attempt ? Math.min(30000, 1000 * (2 ** (attempt - 1))) : 0);
      this.requestsThisRun += 1;
      this.state.metrics.requests = Number(this.state.metrics.requests || 0) + 1;
      this.state.metrics.byHost ||= {};
      const host = new URL(url).hostname;
      this.state.metrics.byHost[host] = Number(this.state.metrics.byHost[host] || 0) + 1;
      const controller = new AbortController();
      this.activeController = controller;
      const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
      try {
        const response = await this.fetchImpl(url, {
          method: "GET",
          headers: options.headers || {},
          credentials: "omit",
          redirect: "follow",
          signal: controller.signal,
        });
        const text = await response.text();
        if (!response.ok) throw new HttpError(response.status, `${options.label || host} HTTP ${response.status}`, retryAfterMs(response));
        if (!text.trim() && options.allowEmpty) {
          if (options.countFailure !== false) this.consecutiveFailures = 0;
          return null;
        }
        if (text.length > 6_000_000) throw new Error(`${options.label || host} response too large`);
        const data = JSON.parse(text);
        if (options.countFailure !== false) this.consecutiveFailures = 0;
        return data;
      } catch (error) {
        if (this.stopRequested) throw new SafetyStop("Interrupted; checkpoint preserved", "interrupted");
        lastError = error;
        const status = Number(error?.status || 0);
        const ignoredFailure = Array.isArray(options.ignoreFailureStatuses) && options.ignoreFailureStatuses.includes(status);
        if (options.countFailure !== false && !ignoredFailure) this.consecutiveFailures += 1;
        const retryable = error?.name === "AbortError" || status === 429 || status >= 500 || /fetch|network|timeout/i.test(String(error?.message || ""));
        if (options.failOnAuth !== false && (status === 401 || status === 403)) {
          throw new SafetyStop(`${options.label || host} changed access policy (HTTP ${status})`, "access_policy");
        }
        if (options.countFailure !== false && !ignoredFailure && this.consecutiveFailures >= this.config.maxConsecutiveFailures) {
          throw new SafetyStop(`${this.consecutiveFailures} consecutive network failures`, "network_circuit");
        }
        if (!retryable || attempt === attempts - 1 || (status === 429 && options.retry429 === false)) throw error;
        if (status === 429 && error.retryAfterMs) await this.sleep(Math.min(error.retryAfterMs, 120000));
      } finally {
        clearTimeout(timer);
        this.lastRequestAt = this.now();
        if (this.activeController === controller) this.activeController = null;
      }
    }
    throw lastError || new Error("request failed");
  }
}

class MetadataKeyPool {
  constructor(provider, keys, controller) {
    this.provider = provider;
    this.keys = keys.map((value, index) => ({ value, label: `${provider}#${index + 1}`, disabled: false }));
    this.controller = controller;
    this.cursor = 0;
  }

  get activeCount() {
    return this.keys.filter((entry) => !entry.disabled).length;
  }

  async search(title) {
    if (!this.keys.length) throw new SafetyStop(`No ${this.provider} keys configured in environment`, "missing_keys");
    let lastError;
    for (let offset = 0; offset < this.keys.length; offset += 1) {
      const index = (this.cursor + offset) % this.keys.length;
      const entry = this.keys[index];
      if (entry.disabled) continue;
      try {
        const data = await this.searchWithKey(title, entry.value, entry.label);
        this.cursor = (index + 1) % this.keys.length;
        return data;
      } catch (error) {
        lastError = error;
        const status = Number(error?.status || 0);
        if ([401, 402, 403, 429].includes(status)) entry.disabled = true;
        else throw error;
      }
    }
    throw new SafetyStop(`All ${this.provider} keys are unavailable or exhausted`, "keys_exhausted");
  }

  async searchWithKey(title, key, label) {
    if (this.provider === "poiskkino") {
      const url = new URL("/v1.4/movie/search", "https://api.poiskkino.dev");
      url.searchParams.set("query", title);
      url.searchParams.set("limit", "12");
      const data = await this.controller.json(url, {
        label,
        attempts: this.controller.config.retries + 1,
        retry429: false,
        failOnAuth: false,
        countFailure: false,
        headers: { Accept: "application/json", "X-API-KEY": key, "User-Agent": GENERIC_UA },
      });
      return Array.isArray(data?.docs) ? data.docs : [];
    }
    const url = new URL("/api/v2.1/films/search-by-keyword", "https://kinopoiskapiunofficial.tech");
    url.searchParams.set("keyword", title);
    url.searchParams.set("page", "1");
    const data = await this.controller.json(url, {
      label,
      attempts: this.controller.config.retries + 1,
      retry429: false,
      failOnAuth: false,
      countFailure: false,
      headers: { Accept: "application/json", "X-API-KEY": key, "User-Agent": GENERIC_UA },
    });
    return Array.isArray(data?.films) ? data.films : [];
  }
}

function newState(config) {
  const now = new Date().toISOString();
  return {
    schema: 1,
    createdAt: now,
    updatedAt: now,
    settings: stateSettings(config),
    mappings: {},
    scans: {},
    metrics: { requests: 0, byHost: {} },
    lastRun: null,
  };
}

function stateSettings(config) {
  return {
    minHeight: config.minHeight,
    seriesMode: config.seriesMode,
    seriesSeasonSamples: config.seriesSeasonSamples,
    seriesSamples: config.seriesSamples,
    voicesPerEpisode: config.voicesPerEpisode,
    maxSeriesVideos: config.maxSeriesVideos,
    maxFilmVideos: config.maxFilmVideos,
  };
}

function settingsEqual(a, b) {
  return JSON.stringify(a || {}) === JSON.stringify(b || {});
}

async function loadState(config) {
  if (config.refresh) return newState(config);
  const state = await readJson(config.statePath, { optional: true });
  if (!state) {
    if (config.command === "status" || config.command === "export") {
      throw new SafetyStop(`No checkpoint at ${config.statePath}`, "no_state");
    }
    return newState(config);
  }
  if (state.schema !== 1) throw new Error(`Unsupported state schema ${state.schema}`);
  if (state.settings && state.settings.seriesSeasonSamples == null) state.settings.seriesSeasonSamples = 3;
  if (config.command !== "status" && config.command !== "export" && !settingsEqual(state.settings, stateSettings(config))) {
    throw new SafetyStop("Scan settings differ from checkpoint; use --refresh or restore the previous settings", "settings_mismatch");
  }
  state.mappings ||= {};
  state.scans ||= {};
  state.metrics ||= { requests: 0, byHost: {} };
  return state;
}

async function loadManualMap(filePath) {
  const data = await readJson(filePath, { optional: true });
  return data && typeof data === "object" && !Array.isArray(data) ? data : {};
}

function manualMapping(candidate, manualMap) {
  const value = manualMap[candidate.key] || manualMap[`title:${normalizeTitle(candidate.title)}`];
  if (!value || !/^\d+$/.test(String(value.kpId || value))) return null;
  return {
    status: "mapped",
    kpId: String(value.kpId || value),
    year: validYear(value.year) || candidate.year,
    isSeries: typeof value.isSeries === "boolean" ? value.isSeries : candidate.isSeries,
    confidence: "manual",
    matchedName: compact(value.title) || candidate.title,
  };
}

async function resolveMappings(candidates, state, config, dependencies) {
  const manualMap = await loadManualMap(config.manualMapPath);
  const controller = dependencies.controller;
  const keys = providerKeys(config.provider, dependencies.env || process.env);
  const pool = new MetadataKeyPool(config.provider, keys, controller);
  for (const candidate of candidates) {
    const existing = state.mappings[candidate.key];
    const manual = manualMapping(candidate, manualMap);
    if (!config.refresh && existing && !(manual && existing.confidence !== "manual")) continue;
    let result;
    if (candidate.kpId) {
      result = {
        status: "mapped",
        kpId: candidate.kpId,
        year: candidate.year,
        isSeries: candidate.isSeries,
        confidence: "provided_kp_id",
        matchedName: candidate.title,
      };
    } else {
      result = manual;
    }
    if (!result && config.provider === "none") {
      result = { status: "unresolved", reason: "provider_disabled", suggestions: [] };
    }
    if (!result) {
      const hits = await pool.search(candidate.title);
      result = matchKinopoiskCandidate(candidate, hits, config.provider);
    }
    state.mappings[candidate.key] = {
      ...result,
      candidate,
      provider: result.confidence === "manual" || result.confidence === "provided_kp_id" ? "local" : config.provider,
      updatedAt: new Date().toISOString(),
    };
    await dependencies.event("mapping", {
      key: candidate.key,
      title: candidate.title,
      status: result.status,
      kpId: result.kpId || null,
      reason: result.reason || null,
    });
    await dependencies.checkpoint();
  }
}

function mappedTitles(candidates, state) {
  const byKp = new Map();
  for (const candidate of candidates) {
    const mapping = state.mappings[candidate.key];
    if (mapping?.status !== "mapped" || !/^\d+$/.test(String(mapping.kpId || ""))) continue;
    const kpId = String(mapping.kpId);
    const previous = byKp.get(kpId);
    const value = {
      kpId,
      title: mapping.matchedName || candidate.title,
      year: mapping.year || candidate.year || null,
      isSeries: typeof mapping.isSeries === "boolean" ? mapping.isSeries : candidate.isSeries,
      priority: candidate.priority,
      candidateKeys: [candidate.key],
      sources: candidate.sources || [candidate.source],
    };
    if (!previous) byKp.set(kpId, value);
    else {
      previous.priority = Math.max(previous.priority, value.priority);
      previous.candidateKeys.push(candidate.key);
      previous.sources = [...new Set([...previous.sources, ...value.sources])];
      previous.year ||= value.year;
      if (previous.isSeries == null) previous.isSeries = value.isSeries;
    }
  }
  return [...byKp.values()].sort((a, b) => b.priority - a.priority || a.title.localeCompare(b.title, "ru"));
}

function scanItemEvidence(item) {
  return {
    vkId: item.vkId,
    season: item.season,
    episode: item.episode,
    voiceStudio: item.voiceStudio,
    voiceType: item.voiceType,
    name: item.name,
  };
}

async function scanTitle(title, state, config, dependencies) {
  const controller = dependencies.controller;
  const previous = state.scans[title.kpId];
  if (!config.refresh && ["confirmed_high_res", "confirmed_no_high_res", "sampled_no_high_res", "series_skipped", "no_collaps"].includes(previous?.status)) return;
  const scan = previous || {
    ...title,
    status: "pending",
    playlist: null,
    queue: null,
    scanned: {},
    best: null,
    errors: [],
    startedAt: new Date().toISOString(),
  };
  state.scans[title.kpId] = scan;
  if (previous && config.refresh) {
    scan.status = "pending";
    scan.playlist = null;
    scan.queue = null;
    scan.coverage = null;
    scan.completedAt = null;
  }
  if (!scan.playlist) {
    const url = new URL(`${COLLAPS_BASE}/playlist`);
    url.searchParams.set("pub", "1");
    url.searchParams.set("aggr", "kp");
    url.searchParams.set("id", title.kpId);
    const raw = await controller.json(url, {
      label: "Collaps playlist",
      allowEmpty: true,
      headers: { Accept: "application/json", Origin: "null", "User-Agent": GENERIC_UA },
    });
    scan.playlist = sanitizePlaylist(raw);
    scan.title = scan.playlist.titleName || scan.title;
    scan.isSeries = !!(scan.playlist.isSeries || scan.isSeries);
    if (!scan.playlist.items.length) {
      scan.status = "no_collaps";
      scan.completedAt = new Date().toISOString();
      await dependencies.event("scan", { kpId: title.kpId, title: scan.title, status: scan.status });
      await dependencies.checkpoint();
      return;
    }
    const probe = buildProbeQueue(scan.playlist.items, { ...config, isSeries: scan.isSeries });
    scan.queue = probe.queue;
    scan.coverage = {
      complete: probe.complete,
      totalUnique: probe.totalUnique,
      queued: probe.queue.length,
      sampledEpisodes: probe.sampledEpisodes,
      mode: scan.isSeries ? config.seriesMode : "film",
    };
    await dependencies.checkpoint();
  }
  if (!scan.queue) {
    const probe = buildProbeQueue(scan.playlist.items, { ...config, isSeries: scan.isSeries });
    scan.queue = probe.queue;
    scan.coverage = { complete: probe.complete, totalUnique: probe.totalUnique, queued: probe.queue.length, sampledEpisodes: probe.sampledEpisodes, mode: scan.isSeries ? config.seriesMode : "film" };
  }
  if (scan.isSeries && config.seriesMode === "skip") {
    scan.status = "series_skipped";
    scan.completedAt = new Date().toISOString();
    await dependencies.event("scan", { kpId: title.kpId, title: scan.title, status: scan.status });
    await dependencies.checkpoint();
    return;
  }
  for (const item of scan.queue) {
    if (scan.scanned[item.vkId]) {
      if (Number(scan.scanned[item.vkId].height || 0) >= config.minHeight) {
        scan.best = scan.scanned[item.vkId];
        scan.status = "confirmed_high_res";
        break;
      }
      continue;
    }
    let raw;
    try {
      raw = await controller.json(`${COLLAPS_BASE}/video/${encodeURIComponent(item.vkId)}`, {
        label: "Collaps video",
        allowEmpty: true,
        ignoreFailureStatuses: [...VIDEO_MISS_STATUSES],
        headers: { Accept: "application/json", Origin: "null", "User-Agent": GENERIC_UA },
      });
    } catch (error) {
      const status = Number(error?.status || 0);
      if (!VIDEO_MISS_STATUSES.has(status)) throw error;
      scan.scanned[item.vkId] = {
        ...scanItemEvidence(item),
        key: null,
        label: null,
        height: 0,
        unavailable: `http_${status}`,
        checkedAt: new Date().toISOString(),
      };
      await dependencies.checkpoint();
      continue;
    }
    const quality = bestQuality(raw?.sources || {});
    const evidence = {
      ...scanItemEvidence(item),
      key: quality?.key || null,
      label: quality?.label || null,
      height: quality?.height || 0,
      checkedAt: new Date().toISOString(),
    };
    scan.scanned[item.vkId] = evidence;
    if (!scan.best || evidence.height > Number(scan.best.height || 0)) scan.best = evidence;
    await dependencies.checkpoint();
    if (evidence.height >= config.minHeight) {
      scan.status = "confirmed_high_res";
      break;
    }
  }
  if (scan.status !== "confirmed_high_res") {
    const scannedAllQueued = scan.queue.every((item) => scan.scanned[item.vkId]);
    scan.status = scannedAllQueued && scan.coverage?.complete ? "confirmed_no_high_res" : "sampled_no_high_res";
  }
  scan.completedAt = new Date().toISOString();
  await dependencies.event("scan", {
    kpId: title.kpId,
    title: scan.title,
    status: scan.status,
    quality: scan.best?.label || null,
    scanned: Object.keys(scan.scanned || {}).length,
    queued: scan.coverage?.queued || 0,
  });
  await dependencies.checkpoint();
}

function publicScan(scan) {
  return {
    kpId: scan.kpId,
    title: cleanDisplayTitle(scan.title),
    year: scan.year || null,
    isSeries: !!scan.isSeries,
    status: scan.status,
    sources: scan.sources || [],
    quality: scan.best ? {
      key: scan.best.key,
      label: scan.best.label,
      height: scan.best.height,
      season: scan.best.season,
      episode: scan.best.episode,
      voiceStudio: scan.best.voiceStudio,
      voiceType: scan.best.voiceType,
    } : null,
    coverage: scan.coverage || null,
    completedAt: scan.completedAt || null,
  };
}

export async function exportOutputs(state, outDir) {
  await fs.mkdir(outDir, { recursive: true });
  const scans = Object.values(state.scans || {}).map(publicScan);
  const positives = scans
    .filter((scan) => scan.status === "confirmed_high_res")
    .sort((a, b) => Number(b.quality?.height || 0) - Number(a.quality?.height || 0) || a.title.localeCompare(b.title, "ru"));
  const review = {
    generatedAt: new Date().toISOString(),
    mappings: Object.values(state.mappings || {})
      .filter((item) => item.status !== "mapped")
      .map((item) => ({ key: item.candidate?.key, title: item.candidate?.title, status: item.status, reason: item.reason, suggestions: item.suggestions || [] })),
    scans: scans.filter((scan) => ["sampled_no_high_res", "series_skipped", "error"].includes(scan.status)),
  };
  const summary = {
    generatedAt: new Date().toISOString(),
    confirmedHighRes: positives.length,
    confirmedHighResMovies: positives.filter((scan) => !scan.isSeries).length,
    confirmedHighResSeries: positives.filter((scan) => scan.isSeries).length,
    confirmed4K: positives.filter((scan) => scan.quality?.label === "4K").length,
    confirmed4KMovies: positives.filter((scan) => scan.quality?.label === "4K" && !scan.isSeries).length,
    confirmed4KSeries: positives.filter((scan) => scan.quality?.label === "4K" && scan.isSeries).length,
    confirmed2K: positives.filter((scan) => scan.quality?.label === "2K" || scan.quality?.label === "1440p").length,
    confirmedNoHighRes: scans.filter((scan) => scan.status === "confirmed_no_high_res").length,
    sampledNoHighRes: scans.filter((scan) => scan.status === "sampled_no_high_res").length,
    noCollaps: scans.filter((scan) => scan.status === "no_collaps").length,
    mappingReview: review.mappings.length,
    requests: state.metrics?.requests || 0,
    byHost: state.metrics?.byHost || {},
  };
  const titles = positives.map((item) => item.title).join("\n") + (positives.length ? "\n" : "");
  const details = ["title\tyear\ttype\tquality\tkpId", ...positives.map((item) => [
    item.title,
    item.year || "",
    item.isSeries ? "series" : "movie",
    item.quality?.label || "",
    item.kpId,
  ].map(tsvCell).join("\t"))].join("\n") + "\n";
  await Promise.all([
    writeAtomic(path.join(outDir, "collaps-4k.json"), JSON.stringify({ generatedAt: summary.generatedAt, items: positives }, null, 2) + "\n"),
    writeAtomic(path.join(outDir, "collaps-4k-titles.txt"), titles),
    writeAtomic(path.join(outDir, "collaps-4k-details.tsv"), details),
    writeAtomic(path.join(outDir, "collaps-4k-review.json"), JSON.stringify(review, null, 2) + "\n"),
    writeAtomic(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n"),
  ]);
  return summary;
}

function tsvCell(value) {
  return String(value ?? "").replace(/[\t\r\n]+/g, " ");
}

async function loadAllCandidates(config) {
  const groups = [];
  if (config.sources.includes("soap4k")) groups.push(await loadSoapCandidates(config.soapPath));
  if (config.sources.includes("curated")) groups.push(await loadCuratedCandidates(config.curatedPath));
  for (const input of config.inputPaths) groups.push(await loadInputCandidates(input));
  return mergeCandidates(groups.flat());
}

function planSummary(candidates, state, config, env = process.env) {
  const alreadyMapped = candidates.filter((item) => state.mappings?.[item.key]?.status === "mapped" || item.kpId).length;
  const needsMapping = candidates.length - alreadyMapped;
  const knownTitles = new Set(candidates.map((item) => item.kpId).filter(Boolean)).size + needsMapping;
  const estimatedVideoUpper = candidates.reduce((sum, item) => sum + (item.isSeries ? config.maxSeriesVideos : config.maxFilmVideos), 0);
  return {
    mode: "offline-plan",
    networkStarted: false,
    candidates: candidates.length,
    alreadyMapped,
    needsMapping,
    configuredKeys: providerKeys(config.provider, env).length,
    requestEstimate: {
      lower: needsMapping + knownTitles * 2,
      upper: needsMapping + knownTitles + estimatedVideoUpper,
      note: "upper bound assumes every title reaches its configured video-probe cap",
    },
    pacingMs: [config.minDelayMs, config.maxDelayMs],
    requestBudget: config.maxRequests,
    seriesMode: config.seriesMode,
    outputDir: config.outDir,
  };
}

export function assertRunAuthorized(config) {
  if (config.command !== "run") return;
  if (config.confirm !== CONFIRM_PHRASE) {
    throw new SafetyStop(`Network run refused. Add --confirm ${CONFIRM_PHRASE} only after explicit approval.`, "confirmation_required");
  }
}

export async function runPipeline(config, dependencies = {}) {
  assertRunAuthorized(config);
  const env = dependencies.env || process.env;
  const state = await loadState(config);
  if (config.command === "status") return summarizeState(state);
  if (config.command === "export") return exportOutputs(state, config.outDir);
  const candidates = await loadAllCandidates(config);
  if (config.command === "plan") return planSummary(candidates, state, config, env);

  await fs.mkdir(config.outDir, { recursive: true });
  const releaseLock = await acquireLock(config);
  let stoppingError = null;
  const checkpoint = async () => {
    state.updatedAt = new Date().toISOString();
    await writeAtomic(config.statePath, JSON.stringify(state, null, 2) + "\n");
  };
  const controller = new RequestController(config, state, dependencies);
  const event = dependencies.event || (async (type, data) => {
    const record = { at: new Date().toISOString(), type, ...data };
    await fs.appendFile(path.join(config.outDir, "events.jsonl"), JSON.stringify(record) + "\n", { mode: 0o600 });
    const detail = data.kpId ? ` -> KP ${data.kpId}` : "";
    process.stderr.write(`[${type}] ${data.title || data.key || ""}${detail}: ${data.status || ""}${data.quality ? ` (${data.quality})` : ""}\n`);
  });
  const deps = { ...dependencies, env, controller, checkpoint, event };
  const selectedCandidates = config.limit ? candidates.slice(0, config.limit) : candidates;
  const onInterrupt = () => controller.stop();
  if (dependencies.handleSignals !== false) {
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onInterrupt);
  }
  try {
    state.lastRun = { startedAt: new Date().toISOString(), status: "running" };
    await checkpoint();
    await resolveMappings(selectedCandidates, state, config, deps);
    const titles = mappedTitles(selectedCandidates, state);
    let consecutiveTitleErrors = 0;
    for (const title of titles) {
      try {
        await scanTitle(title, state, config, deps);
        consecutiveTitleErrors = 0;
      } catch (error) {
        if (error instanceof SafetyStop) throw error;
        const scan = state.scans[title.kpId] || { ...title, scanned: {} };
        scan.status = "error";
        scan.errors = [...(scan.errors || []), { at: new Date().toISOString(), message: String(error?.message || error).slice(0, 240) }].slice(-10);
        state.scans[title.kpId] = scan;
        consecutiveTitleErrors += 1;
        await event("scan", { kpId: title.kpId, title: scan.title, status: "error", message: String(error?.message || error).slice(0, 180) });
        await checkpoint();
        if (consecutiveTitleErrors >= config.maxConsecutiveFailures) {
          throw new SafetyStop(`${consecutiveTitleErrors} consecutive title failures`, "title_circuit");
        }
      }
      await exportOutputs(state, config.outDir);
    }
    state.lastRun = { ...state.lastRun, finishedAt: new Date().toISOString(), status: "complete", requests: controller.requestsThisRun };
    await checkpoint();
    return exportOutputs(state, config.outDir);
  } catch (error) {
    stoppingError = error;
    state.lastRun = { ...state.lastRun, finishedAt: new Date().toISOString(), status: error instanceof SafetyStop ? "stopped" : "failed", code: error?.code || null, message: String(error?.message || error).slice(0, 240), requests: controller.requestsThisRun };
    await checkpoint().catch(() => {});
    await exportOutputs(state, config.outDir).catch(() => {});
    throw error;
  } finally {
    if (dependencies.handleSignals !== false) {
      process.removeListener("SIGINT", onInterrupt);
      process.removeListener("SIGTERM", onInterrupt);
    }
    await releaseLock(stoppingError).catch(() => {});
  }
}

function summarizeState(state) {
  const scans = Object.values(state.scans || {});
  return {
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    lastRun: state.lastRun,
    mappings: {
      total: Object.keys(state.mappings || {}).length,
      mapped: Object.values(state.mappings || {}).filter((item) => item.status === "mapped").length,
      review: Object.values(state.mappings || {}).filter((item) => item.status !== "mapped").length,
    },
    scans: Object.fromEntries([...new Set(scans.map((item) => item.status))].sort().map((status) => [status, scans.filter((item) => item.status === status).length])),
    metrics: state.metrics,
  };
}

async function acquireLock(config) {
  const lockPath = path.join(config.outDir, ".lock");
  if (config.forceUnlock) await fs.unlink(lockPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
  let handle;
  try {
    handle = await fs.open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") throw new SafetyStop(`Lock exists at ${lockPath}; another run may be active`, "lock_exists");
    throw error;
  }
  await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + "\n");
  await handle.close();
  return async () => fs.unlink(lockPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
}

async function readJson(filePath, options = {}) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (options.optional && error.code === "ENOENT") return null;
    throw new Error(`Cannot read JSON ${filePath}: ${error.message}`);
  }
}

async function writeAtomic(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  await fs.writeFile(temp, text, { mode: 0o600 });
  await fs.rename(temp, filePath);
}

function optionMap(argv) {
  const out = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) { out._.push(token); continue; }
    const equal = token.indexOf("=");
    if (equal !== -1) {
      out[token.slice(2, equal)] = token.slice(equal + 1);
      continue;
    }
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) { out[name] = next; index += 1; }
    else out[name] = true;
  }
  return out;
}

function numberOption(value, fallback, { min = -Infinity, max = Infinity, name = "number" } = {}) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) throw new Error(`Invalid --${name}: ${value}`);
  return parsed;
}

export function parseConfig(argv = process.argv.slice(2)) {
  const args = optionMap(argv);
  const knownOptions = new Set([
    "confirm", "curated", "force-unlock", "input", "limit", "manual-map",
    "max-consecutive-failures", "max-delay-ms", "max-film-videos", "max-requests",
    "max-series-videos", "min-delay-ms", "min-height", "out-dir", "provider",
    "refresh", "retries", "series-mode", "series-samples", "series-season-samples", "soap", "sources",
    "state", "timeout-ms", "voices-per-episode",
  ]);
  const unknownOptions = Object.keys(args).filter((name) => name !== "_" && !knownOptions.has(name));
  if (unknownOptions.length) throw new Error(`Unknown option(s): ${unknownOptions.map((name) => `--${name}`).join(", ")}`);
  if (args._.length > 1) throw new Error(`Unexpected argument(s): ${args._.slice(1).join(", ")}`);
  const command = args._[0] || "plan";
  if (!new Set(["plan", "run", "status", "export"]).has(command)) throw new Error(`Unknown command ${command}`);
  const outDir = path.resolve(args["out-dir"] || DEFAULT_OUT_DIR);
  const minDelayMs = numberOption(args["min-delay-ms"], 300, { min: 250, max: 10000, name: "min-delay-ms" });
  const maxDelayMs = numberOption(args["max-delay-ms"], 700, { min: minDelayMs, max: 30000, name: "max-delay-ms" });
  const provider = String(args.provider || "unofficial");
  if (!new Set(["unofficial", "poiskkino", "none"]).has(provider)) throw new Error(`Invalid --provider ${provider}`);
  const seriesMode = String(args["series-mode"] || "staged");
  if (!new Set(["quick", "staged", "full", "skip"]).has(seriesMode)) throw new Error(`Invalid --series-mode ${seriesMode}`);
  const sources = String(args.sources === undefined ? "soap4k,curated" : args.sources).split(",").map((value) => value.trim()).filter(Boolean);
  const unknownSources = sources.filter((value) => !new Set(["soap4k", "curated"]).has(value));
  if (unknownSources.length) throw new Error(`Invalid --sources value(s): ${unknownSources.join(", ")}`);
  return {
    command,
    confirm: String(args.confirm || ""),
    sources,
    soapPath: path.resolve(args.soap || path.join(ROOT, "soap-movies.json")),
    curatedPath: path.resolve(args.curated || path.join(ROOT, "curated-fallback.json")),
    inputPaths: String(args.input || "").split(",").map((value) => value.trim()).filter(Boolean).map((value) => path.resolve(value)),
    outDir,
    statePath: path.resolve(args.state || path.join(outDir, "state.json")),
    manualMapPath: path.resolve(args["manual-map"] || path.join(ROOT, "scripts", "collaps-4k-manual-map.json")),
    provider,
    minHeight: numberOption(args["min-height"], 1440, { min: 1081, max: 4320, name: "min-height" }),
    minDelayMs,
    maxDelayMs,
    maxRequests: numberOption(args["max-requests"], 1500, { min: 1, max: 10000, name: "max-requests" }),
    timeoutMs: numberOption(args["timeout-ms"], 15000, { min: 1000, max: 60000, name: "timeout-ms" }),
    retries: numberOption(args.retries, 2, { min: 0, max: 5, name: "retries" }),
    maxConsecutiveFailures: numberOption(args["max-consecutive-failures"], 5, { min: 2, max: 20, name: "max-consecutive-failures" }),
    seriesMode,
    seriesSeasonSamples: numberOption(args["series-season-samples"], 3, { min: 1, max: 10, name: "series-season-samples" }),
    seriesSamples: numberOption(args["series-samples"], 3, { min: 1, max: 10, name: "series-samples" }),
    voicesPerEpisode: numberOption(args["voices-per-episode"], 2, { min: 1, max: 10, name: "voices-per-episode" }),
    maxSeriesVideos: numberOption(args["max-series-videos"], 48, { min: 1, max: 1000, name: "max-series-videos" }),
    maxFilmVideos: numberOption(args["max-film-videos"], 12, { min: 1, max: 100, name: "max-film-videos" }),
    limit: args.limit == null ? null : numberOption(args.limit, null, { min: 1, max: 100000, name: "limit" }),
    refresh: !!args.refresh,
    forceUnlock: !!args["force-unlock"],
  };
}

function printHelp() {
  process.stdout.write(`Collaps 4K metadata pipeline (no media bytes)\n\n` +
    `Offline commands:\n` +
    `  node scripts/collaps-4k-pipeline.mjs plan\n` +
    `  node scripts/collaps-4k-pipeline.mjs status\n` +
    `  node scripts/collaps-4k-pipeline.mjs export\n\n` +
    `Network command (guarded):\n` +
    `  node scripts/collaps-4k-pipeline.mjs run --confirm ${CONFIRM_PHRASE}\n\n` +
    `Useful options:\n` +
    `  --limit 10                  Scan a bounded first wave\n` +
    `  --input /absolute/file.json Add local candidates\n` +
    `  --provider unofficial|poiskkino|none\n` +
    `  --series-mode quick|staged|full|skip\n` +
    `  --min-delay-ms 300 --max-delay-ms 700\n` +
    `  --max-requests 1500         Hard per-run request budget\n\n` +
    `Defaults: 300-700ms sequential jitter, 1500 request budget, staged series sampling.\n`);
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes("--help") || argv.includes("-h")) { printHelp(); return; }
  const config = parseConfig(argv);
  const result = await runPipeline(config);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main().catch((error) => {
    const prefix = error instanceof SafetyStop ? "STOPPED" : "FAILED";
    process.stderr.write(`${prefix}: ${error.message}\n`);
    process.exitCode = error instanceof SafetyStop ? 2 : 1;
  });
}
