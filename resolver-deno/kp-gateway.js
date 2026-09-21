// Shared misses are coalesced BEFORE Supabase Functions. The common hot path
// remains a direct browser -> Storage read; only cold/stale data reaches here.
export function createKpGateway({ fetcher = fetch, cache = null, token = "", now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  broker = "https://xoathqkggcuyoyutxwri.supabase.co/functions/v1/kp",
  maxEntries = 512, maxBytes = 16 * 1024 * 1024, maxInflight = 32 } = {}) {
  const memory = new Map();
  const inflight = new Map();
  const cooldown = new Map();
  let bytes = 0;
  const hosts = ["xoathqkggcuyoyutxwri", "hcuhanruaclhiltpdegc", "matozzgmaranfemgxpzy"];
  const ttls = { film: 7 * 86400e3, staff: 30 * 86400e3, similars: 30 * 86400e3, search: 6 * 3600e3 };
  const reply = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
  });
  function keep(key, value) {
    const size = JSON.stringify(value).length * 2;
    if (size > maxBytes) return;
    if (memory.has(key)) { bytes -= memory.get(key).bytes; memory.delete(key); }
    memory.set(key, { value, bytes: size }); bytes += size;
    while (memory.size > maxEntries || bytes > maxBytes) {
      const oldest = memory.keys().next().value;
      bytes -= memory.get(oldest).bytes; memory.delete(oldest);
    }
  }
  async function readJson(url, options = {}, timeoutMs = 1500) {
    const response = await fetcher(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok || response.status === 202) return { error: response.status === 202 ? "busy" : "unavailable" };
    return response.json();
  }
  return async function handle(request) {
    if (request.method === "OPTIONS") return reply({ ok: true });
    if (request.method !== "GET") return reply({ error: "method_not_allowed" }, 405);
    const url = new URL(request.url);
    const kind = url.searchParams.get("kind");
    let id = url.searchParams.get("id") || "";
    const q = (url.searchParams.get("q") || "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
    if (kind === "search" ? !q || q.length > 120 : !ttls[kind] || !/^[1-9]\d{0,9}$/.test(id)) return reply({ error: "bad_request" }, 400);
    if (kind === "search") {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(q));
      id = String(parseInt([...new Uint8Array(digest)].slice(0, 6).map((b) => b.toString(16).padStart(2, "0")).join(""), 16) + 1);
    }
    const params = new URLSearchParams(kind === "search" ? { kind, q } : { kind, id });
    const key = params.toString();
    const cacheKey = new Request(`https://alphy-kp-cache.invalid/v2?${key}`);
    const valid = (v) => v?.v === 1 && v.kind === kind && (kind === "search" ? v.query === q : String(v.id) === id)
      && ["ok", "missing"].includes(v.status);
    const fresh = (v) => valid(v) && Date.parse(v.freshUntil) > now();
    const stale = (v) => valid(v) && v.status === "ok";
    let stored = memory.get(key)?.value;
    if (fresh(stored)) return reply(stored);
    if ((cooldown.get(key) || 0) > now()) return stale(stored) ? reply(stored) : reply({ error: "backing_off" }, 503);
    if (inflight.has(key)) return (await inflight.get(key)).clone();
    if (inflight.size >= maxInflight) return stale(stored) ? reply(stored) : reply({ error: "busy" }, 503);
    const deadline = now() + 14000;
    const work = (async () => {
      if (cache) {
        try { const hit = await cache.match(cacheKey); if (hit) { const value = await hit.json(); if (valid(value)) stored = value; } } catch { /* optional cache */ }
        if (fresh(stored)) { keep(key, stored); return reply(stored); }
      }
      const publish = async (value) => {
        keep(key, value);
        if (cache) await cache.put(cacheKey, new Response(JSON.stringify(value), {
          headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=2592000" },
        })).catch(() => {});
        return reply(value);
      };
      let hash = 0;
      for (const char of id) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
      const group = hash % 256;
      const readObject = async () => {
        const slot = Math.floor(now() / ttls[kind] + group / 256);
        for (const target of [group % 3, (group % 3 + 1) % 3]) {
          if (now() >= deadline) return null;
          try {
            const value = await readJson(`https://${hosts[target]}.supabase.co/storage/v1/object/public/kp/v2/${kind}/${id}/${slot}.json`);
            if (fresh(value)) return value;
          } catch { /* replica */ }
        }
        return null;
      };
      try {
        const existing = await readObject();
        if (existing) return publish(existing);
        if (!token) throw new Error("broker_not_configured");
        const value = await readJson(`${broker}?${params}`, { headers: { "x-kp-token": token } }, Math.max(1, Math.min(10000, deadline - now())));
        if (fresh(value)) return publish(value);
        if (value?.error && value.error !== "busy") throw new Error("broker unavailable");
        // Another resolver instance holds the lease. Wait for the public object,
        // not for a sleeping Edge Function or repeated database polls.
        for (const delay of [500, 1000, 2000]) {
          if (now() + delay >= deadline) break;
          await sleep(delay);
          const object = await readObject();
          if (object) return publish(object);
        }
      } catch { /* stale still has the original provider's answer */ }
      cooldown.set(key, now() + 15000);
      if (cooldown.size > maxEntries) cooldown.delete(cooldown.keys().next().value);
      if (stale(stored)) return reply(stored);
      return reply({ error: "temporarily_unavailable" }, 503);
    })();
    inflight.set(key, work);
    try { return (await work).clone(); } finally { inflight.delete(key); }
  };
}
