// Public Zona identity cache. Browsers read the immutable Storage object first;
// this function runs only when that object is absent, acquires a Postgres lease,
// asks the existing resolver once, and publishes kpId -> Zenith identity for
// everybody. The resolver is therefore a cache filler, never a per-user path.

export const BUCKET = "zona";
const SLOT_MS = 30 * 24 * 3600e3;
const RETRY_MS = 60_000;
const LEASE_SECONDS = 30;
const DEFAULT_UPSTREAMS = [
  "https://alphy.tv/api/resolve-zona",
  "https://alphytv.alphy.deno.net/resolve-zona",
];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

const reply = (body: unknown, status = 200, cache = "no-store") =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cache,
    },
  });

export function placementGroup(id: string): number {
  let hash = 0;
  for (const char of String(id)) {
    hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  }
  return hash % 256;
}

export const objectSlot = (id: string, now = Date.now()): number =>
  Math.floor(now / SLOT_MS + placementGroup(id) / 256);
export const slotEnd = (id: string, slot: number): number =>
  (slot + 1 - placementGroup(id) / 256) * SLOT_MS;
export const objectPath = (id: string, slot = objectSlot(id)): string =>
  `v1/${id}/${slot}.json`;

function cleanStored(value: any, id: string, now: number) {
  if (
    value?.v !== 1 || String(value.kpId) !== id ||
    !(Date.parse(value.freshUntil) > now)
  ) return null;
  const zenithId = String(value.zenithId || "");
  if (!/^\d+$/.test(zenithId)) return null;
  let embed: URL;
  try {
    embed = new URL(String(value.embedUrl || ""));
  } catch {
    return null;
  }
  if (
    embed.protocol !== "https:" || embed.hostname !== "api.zenithjs.ws" ||
    embed.pathname !== `/embed/movie/${zenithId}`
  ) return null;
  return value;
}

type Deps = {
  rpc: (name: string, args: Record<string, unknown>) => Promise<any>;
  getObject: (path: string) => Promise<any>;
  putObject: (path: string, body: string) => Promise<void>;
  resolve: (id: string, request: Request) => Promise<any>;
  now?: () => number;
  owner?: string;
};

export function createZonaHandler(deps: Deps) {
  const now = deps.now || (() => Date.now());
  const owner = deps.owner || crypto.randomUUID();

  async function stored(id: string, slot = objectSlot(id, now())) {
    try {
      return cleanStored(await deps.getObject(objectPath(id, slot)), id, now());
    } catch {
      return null;
    }
  }

  return async (request: Request): Promise<Response> => {
    if (request.method === "OPTIONS") {
      return new Response("ok", { headers: CORS });
    }
    if (request.method !== "GET") {
      return reply({ error: "method_not_allowed" }, 405);
    }
    const requestUrl = new URL(request.url);
    const id = (requestUrl.searchParams.get("kpId") || "").trim();
    if (!/^[1-9]\d{0,9}$/.test(id)) return reply({ error: "bad_kp_id" }, 400);

    const slot = objectSlot(id, now());
    const hit = await stored(id, slot);
    if (hit) {
      return reply(
        { ok: true, ...hit, cached: true },
        200,
        "public, max-age=300",
      );
    }

    let lease;
    try {
      [lease] = await deps.rpc("zona_acquire", {
        p_id: Number(id),
        p_owner: owner,
        p_lease_seconds: LEASE_SECONDS,
      });
    } catch {
      return reply({ error: "state_unavailable" }, 503);
    }

    if (!lease?.acquired) {
      const late = await stored(id, slot);
      if (late) {
        return reply(
          { ok: true, ...late, cached: true },
          200,
          "public, max-age=300",
        );
      }
      if (lease?.retry_at && Date.parse(lease.retry_at) > now()) {
        return reply({ error: "backing_off", retryAt: lease.retry_at }, 503);
      }
      return reply({ error: "busy", retryAfter: 1 }, 202);
    }

    let resolved;
    try {
      resolved = await deps.resolve(id, request);
    } catch (error) {
      await deps.rpc("zona_fail", {
        p_id: Number(id),
        p_owner: owner,
        p_version: lease.version,
        p_retry_at: new Date(now() + RETRY_MS).toISOString(),
      }).catch(() => false);
      return reply({ error: "zona_upstream_unavailable" }, 503);
    }
    const zenithId = String(resolved?.zenithId || "");
    if (!/^\d+$/.test(zenithId) || !resolved?.embedUrl) {
      await deps.rpc("zona_fail", {
        p_id: Number(id),
        p_owner: owner,
        p_version: lease.version,
        p_retry_at: new Date(now() + RETRY_MS).toISOString(),
      }).catch(() => false);
      return reply({ error: "zona_upstream_empty" }, 503);
    }

    const freshUntil = new Date(slotEnd(id, slot)).toISOString();
    const object = cleanStored(
      {
        v: 1,
        kpId: Number(id),
        zenithId,
        zenithIds: Array.isArray(resolved.zenithIds)
          ? resolved.zenithIds.map(String)
          : [zenithId],
        embedUrl: String(resolved.embedUrl),
        storedAt: new Date(now()).toISOString(),
        freshUntil,
      },
      id,
      now(),
    );
    if (!object) {
      await deps.rpc("zona_fail", {
        p_id: Number(id),
        p_owner: owner,
        p_version: lease.version,
        p_retry_at: new Date(now() + RETRY_MS).toISOString(),
      }).catch(() => false);
      return reply({ error: "invalid_zona_answer" }, 503);
    }

    try {
      await deps.putObject(objectPath(id, slot), JSON.stringify(object));
    } catch {
      await deps.rpc("zona_fail", {
        p_id: Number(id),
        p_owner: owner,
        p_version: lease.version,
        p_retry_at: new Date(now() + RETRY_MS).toISOString(),
      }).catch(() => false);
      return reply({ error: "cache_publish_failed" }, 503);
    }
    await deps.rpc("zona_complete", {
      p_id: Number(id),
      p_owner: owner,
      p_version: lease.version,
      p_fresh_until: freshUntil,
    }).catch(() => false);
    return reply(
      { ok: true, ...object, cached: false },
      200,
      "public, max-age=300",
    );
  };
}

declare const Deno: any;
if (typeof Deno !== "undefined") {
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const headers = {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
  };
  const upstreams = String(Deno.env.get("ZONA_UPSTREAMS") || "")
    .split(",").map((value: string) => value.trim()).filter(Boolean);
  if (!upstreams.length) upstreams.push(...DEFAULT_UPSTREAMS);
  const rpc = async (name: string, args: Record<string, unknown>) => {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`rpc ${name} ${response.status}`);
    return response.status === 204 ? null : response.json();
  };
  const handle = createZonaHandler({
    rpc,
    async getObject(path) {
      const response = await fetch(
        `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`,
        {
          signal: AbortSignal.timeout(4000),
        },
      );
      return response.ok ? response.json() : null;
    },
    async putObject(path, body) {
      const response = await fetch(
        `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`,
        {
          method: "POST",
          headers: {
            ...headers,
            "Content-Type": "application/json",
            "cache-control": "max-age=31536000",
            "x-upsert": "false",
          },
          body,
          signal: AbortSignal.timeout(6000),
        },
      );
      if (!response.ok) {
        const detail = await response.text();
        if (!/Duplicate|already exists|"statusCode":"409"/i.test(detail)) {
          throw new Error(`storage ${response.status}`);
        }
      }
    },
    async resolve(id) {
      let lastError: unknown;
      for (let index = 0; index < upstreams.length; index += 1) {
        try {
          const url = new URL(upstreams[index]);
          url.searchParams.set("kpId", id);
          const response = await fetch(url, {
            headers: {
              Accept: "application/json",
              "User-Agent": "Alphy-Zona-Cache/1.0",
            },
            signal: AbortSignal.timeout(index === 0 ? 9_000 : 12_000),
          });
          const data = await response.json().catch(() => null);
          if (!response.ok || !data?.ok || !data?.embedUrl) {
            throw new Error(`upstream ${response.status}`);
          }
          return data;
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError || new Error("zona upstream unavailable");
    },
  });
  Deno.serve(handle);
}
