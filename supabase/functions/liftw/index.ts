// LiftW search/metadata relay.
//
// api.liftw.ws was blocked in Russia, and it sends no CORS header at all, so a
// browser cannot read it directly whether or not it is reachable. This relay is
// the only way that data reaches the page. It is deployed to the same rotating
// Supabase projects as the Letterboxd lookup: spreading the workaround across
// several hostnames is the point, since concentrating it on one would recreate
// the single blockable name we are working around.
//
// Playback does NOT come through here. The embed is read straight from
// lift3.ws (which serves `Access-Control-Allow-Origin: *`) and the video comes
// straight from the CDN, so no video ever crosses this function.
//
// This is deliberately NOT a general proxy: only two upstream shapes are
// reachable, and both are rebuilt from validated parts rather than forwarded.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};
const UPSTREAM = "https://api.liftw.ws";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const TIMEOUT_MS = 9000;
// A title's metadata barely moves; a search result set moves a little more.
// Leave headroom for the browser's five-hour parsed-playlist cache, otherwise
// HTTP cache age plus that local TTL can hide new episodes for twelve hours.
const CACHE_INFO = "public, max-age=300";
const CACHE_SEARCH = "public, max-age=3600";

const json = (body: unknown, status = 200, cache = "no-store") =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": cache },
  });

async function upstream(path: string) {
  const response = await fetch(`${UPSTREAM}${path}`, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) return { status: response.status, body: null };
  const text = await response.text();
  try {
    return { status: 200, body: JSON.parse(text) };
  } catch {
    // Upstream answering with something that is not JSON is an upstream fault,
    // not a client one, and must not be passed off as a valid empty result.
    return { status: 502, body: null };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  const mode = url.searchParams.get("mode");

  if (mode === "info") {
    const id = (url.searchParams.get("id") ?? "").trim();
    // LiftW ids are numeric. Anything else is rejected here rather than being
    // handed to the upstream host, which is what keeps this from being a proxy.
    if (!/^\d{1,12}$/.test(id)) return json({ error: "bad id" }, 400);
    const { status, body } = await upstream(`/info/${id}`);
    if (status !== 200) return json({ error: "upstream", status }, status === 404 ? 404 : 502);
    return json(body, 200, CACHE_INFO);
  }

  if (mode === "search") {
    const q = (url.searchParams.get("q") ?? "").trim();
    if (!q || q.length > 120) return json({ error: "bad query" }, 400);
    const { status, body } = await upstream(`/search?q=${encodeURIComponent(q)}`);
    if (status !== 200) return json({ error: "upstream", status }, 502);
    return json(body, 200, CACHE_SEARCH);
  }

  // The player page, for viewers who cannot reach either embed host directly:
  // embed.liftw.ws is blocked in Russia and lift3.ws refuses some addresses, so
  // without this the last resort was a fetch that could only ever time out.
  // HTML only — the video still comes straight from the CDN to the browser.
  if (mode === "embed") {
    const id = (url.searchParams.get("id") ?? "").trim();
    if (!/^\d{1,12}$/.test(id)) return json({ error: "bad id" }, 400);
    // The signature /info issued is passed through as opaque parts; anything
    // else a caller appends is dropped rather than forwarded.
    const signed = new URLSearchParams();
    for (const name of ["host", "imp2", "imp3", "t2", "ht", "season", "episode"]) {
      const value = url.searchParams.get(name);
      if (value && /^[\w.\-]{1,120}$/.test(value)) signed.set(name, value);
    }
    const query = signed.toString();
    for (const host of ["lift3.ws", "embed.liftw.ws"]) {
      try {
        const response = await fetch(`https://${host}/embed/movie/${id}${query ? `?${query}` : ""}`, {
          headers: { "User-Agent": UA, Accept: "text/html" },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!response.ok) continue;
        const html = await response.text();
        // A host that answers with something other than the player is a failed
        // attempt, not an empty title.
        if (!/makePlayer\s*\(/.test(html)) continue;
        return new Response(html, {
          headers: { ...CORS, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=1800" },
        });
      } catch { /* try the next host */ }
    }
    return json({ error: "no embed host answered" }, 502);
  }

  return json({ error: "bad mode" }, 400);
});
