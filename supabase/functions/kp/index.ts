// Shared Kinopoisk Unofficial cache.
//
// Every browser used to spend its own Unofficial quota on the same films: a
// title opened by a thousand people cost a thousand `film` + `staff` +
// `similars` calls, and the pool ran out at about a thousand daily users. Here
// a film is fetched once for everyone and published as a public Storage file,
// which browsers read straight from the CDN. This function is reached only for
// a film that is missing or stale.
//
// How a fill behaves:
//  - one worker per (kind, film): a Postgres lease with a fencing version, so a
//    thousand simultaneous misses make one upstream call and a worker that
//    outlived its lease cannot overwrite the next one's result;
//  - one budget for every key: a key is reserved from today's quota before it
//    is used, 402 retires it until midnight Moscow time, 401 retires it for
//    good, 403/429 bench it for a while;
//  - a failure is never an answer. A timeout or 5xx returns an error and backs
//    the film off for a minute; it is never published as "no similar films".
//
// The objects keep the provider's own shape (staff trimmed to the two
// professions the site reads), so the browser's normalisers are unchanged.

import { createKeyLoader } from "./key-pool.ts";

export const KINDS = ["film", "staff", "similars", "search"];

// Objects are spread over three projects in three organisations: each has its
// own free egress. 256 stable placement groups sit between a film and a
// project, so growing the ring moves groups, not every object.
export const OBJECT_HOSTS = [
  "xoathqkggcuyoyutxwri",
  "hcuhanruaclhiltpdegc",
  "matozzgmaranfemgxpzy",
];
// This map is deliberately independent of ring length. Appending a host must
// not relocate existing objects; migrate explicitly chosen groups instead.
export const GROUP_HOSTS: number[] = Array.from({ length: 256 }, (_, group) => group % 3);
export const BUCKET = "kp";

export function placementGroup(id: string): number {
  let hash = 0;
  for (const char of String(id)) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  return hash % 256;
}

export const hostFor = (id: string): string => OBJECT_HOSTS[GROUP_HOSTS[placementGroup(id)]];
export const replicaFor = (id: string): string => OBJECT_HOSTS[(GROUP_HOSTS[placementGroup(id)] + 1) % 3];

const DAY_MS = 24 * 3600e3;
// Not worse than the browser caches they replace: metadata a week, the lists a
// month. A missing provider identity is retried after six hours.
export const FRESH_MS: Record<string, number> = { film: 7 * DAY_MS, staff: 30 * DAY_MS, similars: 30 * DAY_MS, search: 6 * 3600e3 };
// Immutable time slots, staggered by title: a delayed writer cannot overwrite
// the next refresh, and the entire catalogue never expires at midnight.
export function objectSlot(kind: string, id: string, now = Date.now()): number {
  return Math.floor(now / FRESH_MS[kind] + placementGroup(id) / 256);
}
export const slotEnd = (kind: string, id: string, slot: number): number =>
  (slot + 1 - placementGroup(id) / 256) * FRESH_MS[kind];
export const objectPath = (kind: string, id: string, slot = objectSlot(kind, id)): string => `v2/${kind}/${id}/${slot}.json`;

// A film's card is refetched weekly only while it can still change: a release
// of this year or last, or a series still coming out. 86% of the catalogue is
// older, and its rating and description barely move in a month — its card is
// carried into the new weekly slot as it is, without spending quota, until the
// fetch it came from is RENEW_MS old.
export const RENEW_MS = 60 * DAY_MS;
const SERIES_TYPES = new Set(["TV_SERIES", "MINI_SERIES", "TV_SHOW"]);
export function lastingFilm(data: any, fetchedAt: number, now: number): boolean {
  if (!data || typeof data !== "object" || !(now - fetchedAt < RENEW_MS)) return false;
  const thisYear = new Date(now).getUTCFullYear();
  // A card without a year (Number(null) is 0) is treated as new.
  const year = Number(data.year);
  if (!Number.isInteger(year) || year < 1880 || year >= thisYear - 1) return false;
  // `serial` is false on mini-series; the type is what tells a series apart.
  if ((SERIES_TYPES.has(data.type) || data.serial === true) && data.completed !== true) {
    const end = Number(data.endYear);
    if (!(Number.isInteger(end) && end > 0 && end < thisYear - 1)) return false;
  }
  return true;
}
const MISSING_MS = 6 * 3600e3;
const RETRY_MS = 60_000;
const NO_BUDGET_RETRY_MS = 10 * 60_000;
// Covers the bounded key-pool, two upstream attempts and replica writes.
const LEASE_SECONDS = 60;
// Below the provider's 500 so racing reservations cannot tip a key over.
export const DAILY_LIMIT = 480;
const KEY_ATTEMPTS = 2;
const ACTORS_KEPT = 40;

export function upstreamPath(kind: string, id: string): string {
  if (kind === "film") return `/api/v2.2/films/${id}`;
  if (kind === "similars") return `/api/v2.2/films/${id}/similars`;
  return `/api/v1/staff?filmId=${id}`;
}

// The site reads directors and actors only — the first three and eight, by
// staffId, nameRu/nameEn and professionKey. Every director and the first forty
// actors are kept, in the provider's order, which leaves room for the entries
// the readers skip (no id, no name, duplicates).
export function compactPayload(kind: string, data: unknown): unknown {
  if (kind !== "staff") return data;
  const out: Record<string, unknown>[] = [];
  let actors = 0;
  for (const person of Array.isArray(data) ? data : []) {
    const profession = String(person?.professionKey || "");
    if (profession !== "DIRECTOR" && profession !== "ACTOR") continue;
    if (profession === "ACTOR" && actors >= ACTORS_KEPT) continue;
    if (profession === "ACTOR") actors += 1;
    out.push({
      staffId: person?.staffId ?? null,
      nameRu: person?.nameRu ?? null,
      nameEn: person?.nameEn ?? null,
      professionKey: profession,
    });
  }
  return out;
}

// The provider's daily quota turns over at midnight Moscow time.
export const moscowDay = (now: number): string => new Date(now + 3 * 3600e3).toISOString().slice(0, 10);

export async function keyIdOf(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`alphy-kp:${value}`));
  return [...new Uint8Array(digest)].slice(0, 8).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

const reply = (body: unknown, status = 200, cache = "no-store") => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": cache },
});

type Key = { id: string; value: string };
type Deps = {
  rpc: (name: string, args: Record<string, unknown>) => Promise<any>;
  putObject: (host: string, path: string, body: string, maxAgeSeconds: number) => Promise<void>;
  getObject: (host: string, path: string) => Promise<any>;
  upstream: (path: string, key: string) => Promise<{ status: number; body: any }>;
  keys: () => Promise<Key[]>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  owner?: string;
  token?: string;
};

export function createKpHandler(deps: Deps) {
  const now = deps.now || (() => Date.now());
  const owner = deps.owner || crypto.randomUUID();
  const isFresh = (until: string | null) => !!until && Date.parse(until) > now();

  async function serveStored(kind: string, id: string, host: string | null) {
    try {
      const stored = await deps.getObject(host || hostFor(id), objectPath(kind, id, objectSlot(kind, id, now())));
      if (stored?.v === 1 && stored.kind === kind && String(stored.id) === id && isFresh(stored.freshUntil)) return reply(stored, 200, "public, max-age=300");
    } catch { /* fall through to the caller's error */ }
    return null;
  }

  async function finish(kind: string, id: string, version: number, fields: Record<string, unknown>) {
    try {
      return await deps.rpc("kp_complete_v2", {
        p_kind: kind, p_id: Number(id), p_owner: owner, p_version: version,
        p_status: null, p_host: null, p_fresh_until: null, p_retry_at: null, p_bytes: null,
        ...fields,
      });
    } catch { return false; }
  }

  // Both replicas, then the caller's answer. A slot's first writer wins, and
  // every newer slot has its own URL, so a late writer cannot regress one.
  async function publish(kind: string, id: string, version: number, slot: number, object: Record<string, unknown>) {
    const body = JSON.stringify(object);
    let host = hostFor(id);
    const writes = await Promise.allSettled([host, replicaFor(id)].map(async (target) => {
      await deps.putObject(target, objectPath(kind, id, slot), body, 31536000);
      return target;
    }));
    const written = writes.find((result) => result.status === "fulfilled");
    if (!written || written.status !== "fulfilled") {
      // The caller still gets its answer; the next miss after the back-off
      // will publish it.
      await finish(kind, id, version, { p_retry_at: new Date(now() + RETRY_MS).toISOString() });
      return reply(object, 200);
    }
    host = written.value;
    await finish(kind, id, version, {
      p_status: String(object.status),
      p_host: host,
      p_fresh_until: object.freshUntil,
      p_bytes: body.length,
    });
    return reply(object, 200, "public, max-age=300");
  }

  // The card this film last published, if it may simply move into `slot`.
  // The lease row says where and until when it was published, so this is one
  // read, and a film with no usable card goes straight on to the provider.
  async function carriedFilm(id: string, slot: number, last: any) {
    if (last?.status !== "ok" || !last.fresh_until) return null;
    const previousSlot = objectSlot("film", id, Date.parse(last.fresh_until) - 1);
    if (!(previousSlot < slot)) return null;
    for (const host of [...new Set([last.host || hostFor(id), hostFor(id), replicaFor(id)])]) {
      let previous;
      try { previous = await deps.getObject(host, objectPath("film", id, previousSlot)); } catch { previous = null; }
      if (previous?.v !== 1 || previous.kind !== "film" || String(previous.id) !== id || previous.status !== "ok") continue;
      if (!lastingFilm(previous.data, Date.parse(previous.fetchedAt), now())) return null;
      return {
        ...previous,
        // fetchedAt stays the provider's: it is what the sixty days count from.
        freshUntil: new Date(slotEnd("film", id, slot)).toISOString(),
        renewedAt: new Date(now()).toISOString(),
      };
    }
    return null;
  }

  async function fill(kind: string, id: string, version: number, query = "", last: any = null) {
    const slot = objectSlot(kind, id, now());
    if (kind === "film") {
      const carried = await carriedFilm(id, slot, last);
      if (carried) return publish(kind, id, version, slot, carried);
    }
    let keys;
    try { keys = await deps.keys(); }
    catch {
      await finish(kind, id, version, { p_retry_at: new Date(now() + RETRY_MS).toISOString() });
      return reply({ error: "key_pool_unavailable" }, 503);
    }
    if (!keys.length) {
      await finish(kind, id, version, { p_retry_at: new Date(now() + NO_BUDGET_RETRY_MS).toISOString() });
      return reply({ error: "no_keys" }, 503);
    }
    const day = moscowDay(now());
    for (let attempt = 0; attempt < KEY_ATTEMPTS; attempt += 1) {
      const chosen = await deps.rpc("kp_reserve_key", {
        p_keys: keys.map((key) => key.id), p_day: day, p_limit: DAILY_LIMIT,
      });
      const key = keys.find((entry) => entry.id === chosen);
      if (!key) {
        await finish(kind, id, version, { p_retry_at: new Date(now() + NO_BUDGET_RETRY_MS).toISOString() });
        return reply({ error: "budget_exhausted" }, 503);
      }
      let answer;
      try {
        answer = await deps.upstream(kind === "search" ? `/api/v2.1/films/search-by-keyword?keyword=${encodeURIComponent(query)}&page=1` : upstreamPath(kind, id), key.value);
      } catch {
        await finish(kind, id, version, { p_retry_at: new Date(now() + RETRY_MS).toISOString() });
        return reply({ error: "upstream_unreachable" }, 503);
      }
      if ([401, 402, 403, 429].includes(answer.status)) {
        try { await deps.rpc("kp_key_report", { p_key: key.id, p_day: day, p_status: answer.status }); } catch { /* best effort */ }
        continue;
      }
      const missing = answer.status === 404 || answer.status === 400;
      if (!missing && (answer.status !== 200 || answer.body == null)) {
        await finish(kind, id, version, { p_retry_at: new Date(now() + RETRY_MS).toISOString() });
        return reply({ error: "upstream_failed", status: answer.status }, 503);
      }
      const freshFor = missing ? MISSING_MS : FRESH_MS[kind];
      const object = {
        v: 1,
        kind,
        id: Number(id),
        status: missing ? "missing" : "ok",
        fetchedAt: new Date(now()).toISOString(),
        freshUntil: new Date(Math.min(now() + freshFor, slotEnd(kind, id, slot))).toISOString(),
        ...(query ? { query } : {}),
        data: missing ? null : compactPayload(kind, answer.body),
      };
      // A new title can acquire provider metadata later today. Negative results
      // live in shared state/gateway for six hours, never in a month-long
      // immutable staff/similars URL that could not be replaced on retry.
      if (missing) {
        object.freshUntil = new Date(now() + MISSING_MS).toISOString();
        await finish(kind, id, version, { p_status: "missing", p_fresh_until: object.freshUntil, p_bytes: 0 });
        return reply(object, 200);
      }
      // Never publish an answer into a slot that expired while upstream ran.
      if (!isFresh(object.freshUntil)) {
        await finish(kind, id, version, {});
        return reply({ error: "slot_expired" }, 503);
      }
      return publish(kind, id, version, slot, object);
    }
    await finish(kind, id, version, { p_retry_at: new Date(now() + RETRY_MS).toISOString() });
    return reply({ error: "keys_refused" }, 503);
  }

  return async function handle(req: Request): Promise<Response> {
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
    // Only the resolver and bounded prewarm jobs can spend shared API quota.
    if (deps.token && req.headers.get("x-kp-token") !== deps.token) return reply({ error: "forbidden" }, 403);
    if (req.method !== "GET") return reply({ error: "method_not_allowed" }, 405);
    const url = new URL(req.url);
    const kind = url.searchParams.get("kind") || "";
    const query = (url.searchParams.get("q") || "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
    let id = url.searchParams.get("id") || "";
    if (kind === "search") {
      if (!query || query.length > 120) return reply({ error: "bad_request" }, 400);
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(query));
      id = String(parseInt([...new Uint8Array(digest)].slice(0, 6).map((b) => b.toString(16).padStart(2, "0")).join(""), 16) + 1);
    }
    if (!KINDS.includes(kind) || !(kind === "search" ? /^[1-9]\d{0,14}$/ : /^[1-9]\d{0,9}$/).test(id)) return reply({ error: "bad_request" }, 400);

    let lease;
    try {
      [lease] = await deps.rpc("kp_acquire", {
        p_kind: kind, p_id: Number(id), p_owner: owner, p_lease_seconds: LEASE_SECONDS,
      });
    } catch {
      return reply({ error: "state_unavailable" }, 503);
    }
    if (lease?.acquired) return fill(kind, id, lease.version, query, lease);

    if (lease?.status === "missing" && isFresh(lease.fresh_until)) {
      return reply({ v: 1, kind, id: Number(id), status: "missing", data: null,
        freshUntil: lease.fresh_until, ...(query ? { query } : {}) });
    }

    // Someone else's answer is already published, or is being fetched now.
    if (lease && lease.status !== "pending" && isFresh(lease.fresh_until)) {
      const stored = await serveStored(kind, id, lease.host);
      if (stored) return stored;
    }
    if (lease?.retry_at && Date.parse(lease.retry_at) > now()) {
      return reply({ error: "backing_off", retryAt: lease.retry_at }, 503);
    }
    // The resolver coalesces waiters and retries; no idle Edge Function polls SQL.
    return reply({ error: "busy", retryAfter: 1 }, 202);
  };
}

// ---------------------------------------------------------------- runtime
declare const Deno: any;
if (typeof Deno !== "undefined") {
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const self = new URL(SUPABASE_URL).hostname.split(".")[0];
  // Service keys of the other object hosts, {"<ref>": "<key>"}; never logged.
  let hostKeys: Record<string, string> = {};
  try { hostKeys = JSON.parse(Deno.env.get("KP_HOST_KEYS") ?? "{}"); } catch { hostKeys = {}; }
  hostKeys[self] = SERVICE_KEY;

  const rpc = async (name: string, args: Record<string, unknown>) => {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
      method: "POST", headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(args), signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`rpc ${name} ${response.status}`);
    return response.status === 204 ? null : response.json();
  };
  const keys = createKeyLoader({
    rpc,
    background: (promise) => {
      const runtime = (globalThis as any).EdgeRuntime;
      if (runtime?.waitUntil) runtime.waitUntil(promise);
    },
    async loadManaged() {
      const token = Deno.env.get("ALPHY_KEY_POOL_TOKEN");
      let values: string[], revision = 0;
      if (token) {
        const r = await fetch("https://alphy.tv/api/key-pool/runtime", {
          headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) throw new Error("managed pool unavailable");
        const payload = await r.json();
        if (!Array.isArray(payload?.pool?.keys) || !Number.isInteger(payload.pool.revision)) throw new Error("invalid managed pool");
        revision = payload.pool.revision;
        values = payload.pool.keys.filter((entry: any) => entry.provider === "unofficial").map((entry: any) => entry.value);
      } else values = String(Deno.env.get("KU_KEYS") ?? "").split(",").map((value) => value.trim()).filter(Boolean);
      return { revision, keys: await Promise.all([...new Set(values)].map(async (value) => ({ id: await keyIdOf(value), value }))) };
    },
  });

  const handle = createKpHandler({
    token: Deno.env.get("KP_BROKER_TOKEN") || "unconfigured-deny-all",
    keys,
    rpc,
    async putObject(host, path, body, maxAgeSeconds) {
      const key = hostKeys[host];
      if (!key) throw new Error(`no key for ${host}`);
      const response = await fetch(`https://${host}.supabase.co/storage/v1/object/${BUCKET}/${path}`, {
        method: "POST",
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "cache-control": `max-age=${maxAgeSeconds}`,
          "x-upsert": "false",
        },
        body,
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) {
        const detail = await response.text();
        // First successful writer wins within a slot. Every newer slot has its
        // own URL, so neither lease expiry nor CDN staleness can regress it.
        if (!/Duplicate|already exists|"statusCode":"409"/i.test(detail)) throw new Error(`storage ${host} ${response.status}`);
      }
    },
    async getObject(host, path) {
      const response = await fetch(`https://${host}.supabase.co/storage/v1/object/public/${BUCKET}/${path}`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return null;
      return response.json();
    },
    async upstream(path, key) {
      const response = await fetch(`https://kinopoiskapiunofficial.tech${path}`, {
        headers: { "X-API-KEY": key, Accept: "application/json" },
        signal: AbortSignal.timeout(7000),
      });
      const text = await response.text();
      let body = null;
      try { body = JSON.parse(text); } catch { body = null; }
      return { status: response.status, body };
    },
  });

  Deno.serve(handle);
}
