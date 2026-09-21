// Deno Deploy entrypoint for the AlphyTV resolver.
//
// Why this exists: the same resolver logic runs on Cloudflare Workers
// (worker/src/index.js), but a Worker executes on the Cloudflare PoP nearest
// the user, and the PoP serving Russian users gets EMPTY responses from
// mzona.net/getVideoSources (its egress IP is filtered). A non-Cloudflare host
// resolves fine (verified from RU via Deno's EU region). This wrapper reuses the
// exact same handler so there is a single source of truth — only the
// environment plumbing and a kpId->Zenith cache live here.
//
// The cache matters: mzona soft rate-limits per egress IP, and that IP is shared
// across Deno Deploy tenants. Caching each kpId->Zenith mapping (stable for days)
// means a popular title hits mzona ONCE, then serves from KV instantly — far
// fewer upstream calls, far less chance of tripping the rate limit.
//
// Deploy: Deno Deploy app, entrypoint `resolver-deno/main.js`. Link the unified
// registry once with ALPHY_KEY_POOL_TOKEN; legacy provider env keys remain the
// bootstrap fallback until that link succeeds.

import worker, { pickAllowOrigin } from "../worker/src/index.js";
import { createKpGateway } from "./kp-gateway.js";
import { createPersistentCache } from "./persistent-cache.js";

const env = {
  // Primary metadata source (kinopoisk.dev / poiskkino). A POOL of keys may be set
  // comma-separated in POISKKINO_TOKENS (~200/day each, rotated by exhaustion); the
  // singular POISKKINO_TOKEN is still honoured. This is the only IMDb-capable source
  // (the unofficial fallback's search carries no IMDb), so keeping it funded keeps
  // IMDb ratings on the search page.
  POISKKINO_TOKENS: Deno.env.get("POISKKINO_TOKENS"),
  POISKKINO_TOKEN: Deno.env.get("POISKKINO_TOKEN"),
  POISKKINO_BASE_URL: Deno.env.get("POISKKINO_BASE_URL") || "https://api.poiskkino.dev",
  // Fallback metadata when the primary daily quota (200/day) is exhausted. A POOL
  // of kinopoiskapiunofficial keys (comma-separated in KINOPOISK_UNOFFICIAL_TOKENS,
  // ~500/day each) rotated by exhaustion; the singular var is still honoured.
  KINOPOISK_UNOFFICIAL_TOKENS: Deno.env.get("KINOPOISK_UNOFFICIAL_TOKENS"),
  KINOPOISK_UNOFFICIAL_TOKEN: Deno.env.get("KINOPOISK_UNOFFICIAL_TOKEN"),
  KINOPOISK_UNOFFICIAL_BASE_URL: Deno.env.get("KINOPOISK_UNOFFICIAL_BASE_URL") || "https://kinopoiskapiunofficial.tech",
  ALLOWED_ORIGIN:
    Deno.env.get("ALLOWED_ORIGIN") ||
    "https://alphytv.vercel.app,https://alphy.tv,https://www.alphy.tv,http://127.0.0.1:5177,http://localhost:5177",
  __KEY_POOL_MANAGED: false,
  __KEY_POOL_KEYS: [],
  __recordKeyAttempt: null,
};

const KEY_POOL_RUNTIME_TOKEN = Deno.env.get("ALPHY_KEY_POOL_TOKEN") || "";
const KEY_POOL_RUNTIME_URL =
  Deno.env.get("ALPHY_KEY_POOL_URL") || "https://alphy.tv/api/key-pool/runtime";
// Admin saves trigger /key-pool/reload immediately. Five-minute polling is only
// a recovery path for missed reloads and keeps Vercel Function/Blob traffic tiny.
const KEY_POOL_REFRESH_MS = 5 * 60_000;

const keyPoolState = {
  revision: 0,
  updatedAt: null,
  fetchedAt: 0,
  lastError: "",
  inflight: null,
  importedLegacy: false,
};

function splitTokens(plural, singular) {
  const values = String(plural || "").split(",").map((value) => value.trim());
  if (singular) values.push(String(singular).trim());
  return [...new Set(values.filter(Boolean))];
}

function legacyKeyPayload() {
  return [
    ...splitTokens(env.POISKKINO_TOKENS, env.POISKKINO_TOKEN).map((value, index) => ({
      provider: "poiskkino",
      value,
      label: `Deno legacy PoiskKino ${index + 1}`,
    })),
    ...splitTokens(env.KINOPOISK_UNOFFICIAL_TOKENS, env.KINOPOISK_UNOFFICIAL_TOKEN).map((value, index) => ({
      provider: "unofficial",
      value,
      label: `Deno legacy Unofficial ${index + 1}`,
    })),
  ];
}

function normalizeRuntimeKeys(value) {
  const keys = [];
  const seen = new Set();
  for (const raw of Array.isArray(value) ? value : []) {
    const id = String(raw?.id || "").trim();
    const provider = String(raw?.provider || "").trim();
    const key = String(raw?.value || "").trim();
    if (!id || !key || !["poiskkino", "unofficial"].includes(provider)) continue;
    const dedupe = `${provider}\0${key}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    keys.push({
      id,
      provider,
      label: String(raw?.label || provider).trim().slice(0, 80),
      value: key,
      scopes: {
        resolver: raw?.scopes?.resolver === true,
        recommendations: provider === "unofficial" && raw?.scopes?.recommendations === true,
      },
    });
  }
  return keys;
}

async function refreshKeyPool(force = false) {
  if (!KEY_POOL_RUNTIME_TOKEN) return false;
  if (!force && keyPoolState.fetchedAt && Date.now() - keyPoolState.fetchedAt < KEY_POOL_REFRESH_MS) {
    return env.__KEY_POOL_MANAGED;
  }
  if (keyPoolState.inflight) return keyPoolState.inflight;

  keyPoolState.inflight = (async () => {
    try {
      const shouldImport = !keyPoolState.importedLegacy;
      const response = await fetch(KEY_POOL_RUNTIME_URL, {
        method: shouldImport ? "POST" : "GET",
        headers: {
          "Authorization": `Bearer ${KEY_POOL_RUNTIME_TOKEN}`,
          "Accept": "application/json",
          ...(shouldImport ? { "Content-Type": "application/json" } : {}),
        },
        body: shouldImport ? JSON.stringify({ legacyKeys: legacyKeyPayload() }) : undefined,
        cache: "no-store",
      });
      const text = await response.text();
      let payload = null;
      try { payload = JSON.parse(text); } catch { /* surface the HTTP body below */ }
      if (!response.ok || payload?.ok === false || !payload?.pool) {
        throw new Error(payload?.error || text.slice(0, 160) || `runtime pool HTTP ${response.status}`);
      }
      env.__KEY_POOL_KEYS = normalizeRuntimeKeys(payload.pool.keys);
      env.__KEY_POOL_MANAGED = true;
      keyPoolState.revision = Number(payload.pool.revision) || 0;
      keyPoolState.updatedAt = payload.pool.updatedAt || null;
      keyPoolState.fetchedAt = Date.now();
      keyPoolState.lastError = "";
      keyPoolState.importedLegacy = true;
      return true;
    } catch (error) {
      keyPoolState.lastError = String(error?.message || error).slice(0, 240);
      // A previously loaded registry is safer than falling back to env after an
      // admin explicitly disabled a key. Only a never-linked instance uses env.
      return env.__KEY_POOL_MANAGED;
    } finally {
      keyPoolState.inflight = null;
    }
  })();
  return keyPoolState.inflight;
}

// Persistent kpId -> Zenith cache. Deno KV is optional and is not automatically
// attached to every Deploy project. The edge Cache API needs no database setup,
// while the in-memory map protects a warm isolate. We use all available layers
// so a missing KV can never silently turn every page view into a fresh mzona
// request (mzona soft-rate-limits shared datacenter egress).
let kv = null;
try {
  kv = await Deno.openKv();
} catch {
  kv = null;
}
let edgeCache = null;
try {
  edgeCache = globalThis.caches?.open ? await globalThis.caches.open("alphy-zona-v1") : null;
} catch {
  edgeCache = null;
}

// Approximate persistent usage counters. Cache API is already available on this
// deployment and avoids a database or a write per request. Warm isolates update
// memory synchronously; snapshots flush every few calls and whenever admin opens
// the key manager. Concurrent cold isolates can race, so the UI labels these as
// operational counters rather than billing-authoritative quota numbers.
const KEY_METRICS_CACHE_URL = "https://alphy-key-metrics.invalid/v1";
const keyMetrics = new Map();
let keyMetricsLoaded = false;
let keyMetricsLoadPromise = null;
let keyMetricsDirty = 0;
let keyMetricsFlushTimer = null;
let keyMetricsFlushPromise = null;

async function loadKeyMetrics() {
  if (keyMetricsLoaded) return;
  if (keyMetricsLoadPromise) return keyMetricsLoadPromise;
  keyMetricsLoadPromise = (async () => {
    if (!edgeCache) return;
    try {
      const response = await edgeCache.match(new Request(KEY_METRICS_CACHE_URL));
      if (!response) return;
      const payload = await response.json();
      for (const entry of Array.isArray(payload?.keys) ? payload.keys : []) {
        if (!entry?.id) continue;
        keyMetrics.set(String(entry.id), {
          id: String(entry.id),
          provider: String(entry.provider || ""),
          label: String(entry.label || ""),
          requests: Math.max(0, Number(entry.requests) || 0),
          successes: Math.max(0, Number(entry.successes) || 0),
          errors: Math.max(0, Number(entry.errors) || 0),
          totalLatencyMs: Math.max(0, Number(entry.totalLatencyMs) || 0),
          lastStatus: Number(entry.lastStatus) || 0,
          lastUsedAt: entry.lastUsedAt || null,
          lastError: String(entry.lastError || "").slice(0, 180),
          operations: entry.operations && typeof entry.operations === "object" ? entry.operations : {},
        });
      }
    } catch {
      // Counters are observability only; API traffic must never depend on them.
    }
  })().finally(() => {
    keyMetricsLoaded = true;
    keyMetricsLoadPromise = null;
  });
  return keyMetricsLoadPromise;
}

function metricsSnapshot() {
  return [...keyMetrics.values()].map((entry) => ({
    ...entry,
    averageLatencyMs: entry.requests ? Math.round(entry.totalLatencyMs / entry.requests) : 0,
  }));
}

async function flushKeyMetrics() {
  if (!edgeCache || !keyMetricsDirty) return;
  if (keyMetricsFlushPromise) return keyMetricsFlushPromise;
  if (keyMetricsFlushTimer) {
    clearTimeout(keyMetricsFlushTimer);
    keyMetricsFlushTimer = null;
  }
  const dirtyAtStart = keyMetricsDirty;
  keyMetricsFlushPromise = edgeCache.put(
    new Request(KEY_METRICS_CACHE_URL),
    new Response(JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), keys: metricsSnapshot() }), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "public, max-age=31536000",
      },
    }),
  ).then(() => {
    keyMetricsDirty = Math.max(0, keyMetricsDirty - dirtyAtStart);
  }).catch(() => {}).finally(() => {
    keyMetricsFlushPromise = null;
  });
  return keyMetricsFlushPromise;
}

function scheduleMetricsFlush() {
  if (keyMetricsDirty >= 8) {
    flushKeyMetrics();
    return;
  }
  if (!keyMetricsFlushTimer) {
    keyMetricsFlushTimer = setTimeout(() => {
      keyMetricsFlushTimer = null;
      flushKeyMetrics();
    }, 15_000);
  }
}

function recordKeyAttempt(event) {
  const id = String(event?.id || "");
  if (!id) return;
  const current = keyMetrics.get(id) || {
    id,
    provider: String(event.provider || ""),
    label: String(event.label || ""),
    requests: 0,
    successes: 0,
    errors: 0,
    totalLatencyMs: 0,
    lastStatus: 0,
    lastUsedAt: null,
    lastError: "",
    operations: {},
  };
  current.provider = String(event.provider || current.provider);
  current.label = String(event.label || current.label);
  current.requests += 1;
  current.successes += event.ok ? 1 : 0;
  current.errors += event.ok ? 0 : 1;
  current.totalLatencyMs += Math.max(0, Number(event.latencyMs) || 0);
  current.lastStatus = Number(event.status) || 0;
  current.lastUsedAt = new Date().toISOString();
  current.lastError = event.ok ? "" : String(event.error || "").slice(0, 180);
  const operation = String(event.operation || "other").slice(0, 60);
  current.operations[operation] = (Number(current.operations[operation]) || 0) + 1;
  keyMetrics.set(id, current);
  keyMetricsDirty += 1;
  scheduleMetricsFlush();
}

env.__recordKeyAttempt = recordKeyAttempt;

const zonaMemoryCache = new Map();
const zonaInflight = new Map();
const zenithMemoryCache = new Map();
const zenithInflight = new Map();
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ZENITH_FRESH_MS = 60 * 60 * 1000;
const ZENITH_STALE_MS = 24 * 60 * 60 * 1000;
const durableZona = createPersistentCache({ url: Deno.env.get("ALPHY_CACHE_URL"), key: Deno.env.get("ALPHY_CACHE_SERVICE_KEY") });
function keepBounded(map, key, value) {
  map.delete(key); map.set(key, value);
  while (map.size > 512) map.delete(map.keys().next().value);
}

function corsHeadersFor(request) {
  const requestOrigin = request.headers.get("origin") || "";
  return {
    "access-control-allow-origin": pickAllowOrigin(requestOrigin, env.ALLOWED_ORIGIN),
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
    "vary": "Origin",
  };
}

function jsonResponse(request, body, status = 200, cacheControl = "no-store") {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      ...corsHeadersFor(request),
      "content-type": "application/json; charset=utf-8",
      "cache-control": cacheControl,
    },
  });
}

function safeTokenEqual(left, right) {
  const a = new TextEncoder().encode(String(left || ""));
  const b = new TextEncoder().encode(String(right || ""));
  if (!a.length || a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a[index] ^ b[index];
  return diff === 0;
}

function keyPoolAuthorized(request) {
  const supplied = String(request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  return safeTokenEqual(KEY_POOL_RUNTIME_TOKEN, supplied);
}

function managedKeySummary() {
  const providerIndexes = new Map();
  const configured = env.__KEY_POOL_MANAGED ? env.__KEY_POOL_KEYS : legacyKeyPayload().map((entry) => {
    const index = (providerIndexes.get(entry.provider) || 0) + 1;
    providerIndexes.set(entry.provider, index);
    return {
      id: `legacy-${entry.provider}-${index}`,
      provider: entry.provider,
      label: entry.label,
      scopes: { resolver: true, recommendations: entry.provider === "unofficial" },
    };
  });
  return configured.map((entry) => ({
    id: entry.id,
    provider: entry.provider,
    label: entry.label,
    scopes: entry.scopes,
  }));
}

async function keyPoolStatusResponse(request, { reload = false } = {}) {
  if (!KEY_POOL_RUNTIME_TOKEN) {
    return jsonResponse(request, {
      ok: false,
      error: "key_pool_runtime_token_not_configured",
    }, 503);
  }
  if (!keyPoolAuthorized(request)) {
    return jsonResponse(request, { ok: false, error: "key_pool_runtime_auth_required" }, 401);
  }
  await Promise.all([refreshKeyPool(reload), loadKeyMetrics()]);
  await flushKeyMetrics();
  const metrics = metricsSnapshot();
  const totals = metrics.reduce((sum, entry) => {
    sum.requests += entry.requests;
    sum.successes += entry.successes;
    sum.errors += entry.errors;
    sum.totalLatencyMs += entry.totalLatencyMs;
    return sum;
  }, { requests: 0, successes: 0, errors: 0, totalLatencyMs: 0 });
  return jsonResponse(request, {
    ok: true,
    managed: env.__KEY_POOL_MANAGED,
    revision: keyPoolState.revision,
    updatedAt: keyPoolState.updatedAt,
    fetchedAt: keyPoolState.fetchedAt ? new Date(keyPoolState.fetchedAt).toISOString() : null,
    lastError: keyPoolState.lastError || null,
    keys: managedKeySummary(),
    metrics,
    totals: {
      ...totals,
      averageLatencyMs: totals.requests ? Math.round(totals.totalLatencyMs / totals.requests) : 0,
    },
    metricsNote: "approximate_edge_cache_counters",
  });
}

function zonaCacheRequest(kpId) {
  return new Request(`https://alphy-zona-cache.invalid/${encodeURIComponent(kpId)}`);
}

async function readZonaCache(kpId) {
  const memoryHit = zonaMemoryCache.get(kpId);
  if (memoryHit?.embedUrl && memoryHit.storedAt && Date.now() - memoryHit.storedAt < CACHE_TTL_MS) return { ...memoryHit, cache: "memory" };

  if (kv) {
    try {
      const hit = await kv.get(["zona", kpId]);
      if (hit.value?.embedUrl && hit.value.storedAt && Date.now() - hit.value.storedAt < CACHE_TTL_MS) {
        keepBounded(zonaMemoryCache, kpId, hit.value);
        return { ...hit.value, cache: "kv" };
      }
    } catch {
      // Keep serving through the other cache layers.
    }
  }

  if (edgeCache) {
    try {
      const hit = await edgeCache.match(zonaCacheRequest(kpId));
      if (hit) {
        const value = await hit.json();
        if (value?.embedUrl && value.storedAt && Date.now() - value.storedAt < CACHE_TTL_MS) {
          keepBounded(zonaMemoryCache, kpId, value);
          return { ...value, cache: "edge" };
        }
      }
    } catch {
      // Keep serving through mzona.
    }
  }

  const durable = await durableZona.get(kpId);
  if (durable?.embedUrl) {
    keepBounded(zonaMemoryCache, kpId, durable);
    return { ...durable, cache: "storage" };
  }
  return null;
}

async function writeZonaCache(value) {
  if (!value?.kpId || !value?.embedUrl || !value?.zenithId) return;
  const stored = {
    storedAt: Date.now(),
    kpId: String(value.kpId),
    zenithId: String(value.zenithId),
    zenithIds: value.zenithIds || [String(value.zenithId)],
    embedUrl: value.embedUrl,
  };
  keepBounded(zonaMemoryCache, stored.kpId, stored);

  const writes = [durableZona.set(stored.kpId, stored)];
  if (kv) {
    writes.push(kv.set(["zona", stored.kpId], stored, { expireIn: CACHE_TTL_MS }));
  }
  if (edgeCache) {
    writes.push(edgeCache.put(
      zonaCacheRequest(stored.kpId),
      new Response(JSON.stringify(stored), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": `public, max-age=${Math.floor(CACHE_TTL_MS / 1000)}`,
        },
      }),
    ));
  }
  await Promise.allSettled(writes);
}

async function resolveAndCacheZona(request, kpId) {
  const workerUrl = new URL(request.url);
  workerUrl.searchParams.set("kpId", kpId);
  const response = await worker.fetch(new Request(workerUrl, {
    method: request.method,
    headers: request.headers,
  }), env);
  try {
    const data = await response.clone().json();
    if (response.ok && data?.ok && data.embedUrl && data.zenithId) {
      await writeZonaCache(data);
    }
  } catch {
    // Preserve the original resolver response.
  }
  return response;
}

async function handleResolveZonaCached(request, url) {
  const kpId = (url.searchParams.get("kpId") || url.searchParams.get("id") || "").trim();
  if (!/^\d+$/.test(kpId)) return worker.fetch(request, env);

  const hit = await readZonaCache(kpId);
  if (hit?.embedUrl) {
    return jsonResponse(request, { ok: true, ...hit, cached: true }, 200, "public, max-age=300");
  }

  // Collapse simultaneous requests for the same title. Without this, one page
  // refresh can consume several scarce mzona calls before the first one caches.
  const inflightKey = `${kpId}|${request.headers.get("origin") || ""}`;
  if (!zonaInflight.has(inflightKey)) {
    const pending = resolveAndCacheZona(request, kpId).finally(() => zonaInflight.delete(inflightKey));
    zonaInflight.set(inflightKey, pending);
  }
  const response = await zonaInflight.get(inflightKey);
  // A Response body can be consumed only once; every waiter gets its own clone.
  return response.clone();
}

function zenithCacheRequest(id) {
  return new Request(`https://alphy-zenith-cache.invalid/${encodeURIComponent(id)}`);
}

async function readZenithCache(id) {
  let stored = zenithMemoryCache.get(id) || null;
  if (!stored && edgeCache) {
    try {
      const response = await edgeCache.match(zenithCacheRequest(id));
      if (response) {
        stored = await response.json();
        if (stored?.value?.hasSources) keepBounded(zenithMemoryCache, id, stored);
      }
    } catch {
      // A cache miss must never break the live resolver.
    }
  }
  if (!stored?.value?.hasSources || !stored.storedAt) return null;
  const age = Date.now() - stored.storedAt;
  if (age > ZENITH_STALE_MS) return null;
  return { ...stored, fresh: age <= ZENITH_FRESH_MS };
}

async function writeZenithCache(id, value) {
  const stored = { storedAt: Date.now(), value };
  keepBounded(zenithMemoryCache, id, stored);
  if (edgeCache) {
    await edgeCache.put(
      zenithCacheRequest(id),
      new Response(JSON.stringify(stored), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": `public, max-age=${Math.floor(ZENITH_STALE_MS / 1000)}`,
        },
      }),
    ).catch(() => {});
  }
}

async function fetchAndCacheZenith(request, id) {
  const response = await worker.fetch(request, env);
  try {
    const value = await response.clone().json();
    if (response.ok && value?.ok && value?.hasSources) {
      await writeZenithCache(id, value);
    }
  } catch {
    // Preserve the upstream response unchanged.
  }
  return response;
}

async function handleZenithCached(request, url) {
  const idOrUrl = (url.searchParams.get("id") || url.searchParams.get("url") || "").trim();
  const id = idOrUrl.match(/(?:^|\/)(\d+)(?:$|[/?#])/)?.[1] || idOrUrl.match(/^\d+$/)?.[0] || "";
  if (!id) return worker.fetch(request, env);

  const cached = await readZenithCache(id);
  if (cached?.fresh) {
    return jsonResponse(request, { ...cached.value, cached: true }, 200, "public, max-age=300");
  }

  const inflightKey = `${id}|${request.headers.get("origin") || ""}`;
  if (!zenithInflight.has(inflightKey)) {
    const pending = fetchAndCacheZenith(request, id).finally(() => zenithInflight.delete(inflightKey));
    zenithInflight.set(inflightKey, pending);
  }
  const response = await zenithInflight.get(inflightKey);
  if (response.ok || !cached?.value) return response.clone();

  return jsonResponse(request, {
    ...cached.value,
    cached: true,
    stale: true,
  }, 200, "public, max-age=60");
}

const listenPort = Number(Deno.env.get("ALPHY_LOCAL_PORT") || 8000);
const kpGateway = createKpGateway({ cache: edgeCache, token: Deno.env.get("KP_BROKER_TOKEN") || "" });
Deno.serve({ port: listenPort }, async (request, info) => {
  const url = new URL(request.url);
  if (url.pathname === "/kp") return kpGateway(request);
  if (url.pathname === "/resolve-rezka") {
    const headers = new Headers(request.headers);
    const forwarded = String(headers.get("x-forwarded-for") || "").split(",", 1)[0].trim();
    const realIp = String(headers.get("x-real-ip") || "").trim();
    const remoteIp = info.remoteAddr && "hostname" in info.remoteAddr
      ? String(info.remoteAddr.hostname || "").trim()
      : "";
    const clientIp = Deno.env.get("ALPHY_TEST_CLIENT_IP") || forwarded || realIp || remoteIp;
    // Always overwrite the public request value inside our Deno -> shared-worker
    // handoff. RezkaClient validates the resulting address again before forwarding.
    headers.set("x-alphy-client-ip", clientIp);
    request = new Request(request, { headers });
  }
  if (url.pathname === "/key-pool/status" && request.method === "GET") {
    return keyPoolStatusResponse(request);
  }
  if (url.pathname === "/key-pool/reload" && request.method === "POST") {
    return keyPoolStatusResponse(request, { reload: true });
  }

  // Only /search, /movie and /recommendations spend provider keys. The rest
  // start the refresh without waiting for it: on a fresh instance that wait is a
  // round trip to Vercel and Supabase in front of its first resolve, and again
  // in front of one request every five minutes.
  const keysReady = Promise.all([refreshKeyPool(false), loadKeyMetrics()]);
  if (url.pathname === "/search" || url.pathname === "/movie" || url.pathname.startsWith("/recommendations/")) await keysReady;
  else keysReady.catch(() => {});
  if (request.method === "GET" && url.pathname === "/resolve-zona") {
    return handleResolveZonaCached(request, url);
  }
  if (request.method === "GET" && url.pathname === "/zenith") {
    return handleZenithCached(request, url);
  }
  if (request.method === "GET" && url.pathname === "/health" && url.searchParams.has("diag")) {
    return jsonResponse(request, {
      ok: true,
      service: "alphy-resolver",
      zonaCache: {
        kv: !!kv,
        edge: !!edgeCache,
        memoryEntries: zonaMemoryCache.size,
      },
      zenithCache: {
        edge: !!edgeCache,
        memoryEntries: zenithMemoryCache.size,
      },
      keyPool: {
        linked: !!KEY_POOL_RUNTIME_TOKEN,
        managed: env.__KEY_POOL_MANAGED,
        revision: keyPoolState.revision,
        keys: managedKeySummary().length,
      },
    });
  }
  return worker.fetch(request, env);
});
