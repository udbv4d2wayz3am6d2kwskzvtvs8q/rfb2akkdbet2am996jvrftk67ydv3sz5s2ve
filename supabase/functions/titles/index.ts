// Builds the mirrored catalogue into one static shard per first letter, and
// serves a shard directly as a fallback.
//
// It lives here rather than on the Cloudflare Worker that builds the index
// because Workers are throttled from Russia, which is the audience. The crawler
// stays on Cloudflare — it only ever talks to the source, never to a viewer.
//
// Viewers do NOT normally reach this function at all. Cloudflare sits in front
// of Supabase Functions with `cf-cache-status: DYNAMIC` — it never caches a
// function response, whatever Cache-Control says — so every shard request used
// to re-run this code and re-read Postgres: 1.7-2.3s and up to ten PostgREST
// pages for one letter, per viewer, forever. Storage objects ARE cached by that
// same CDN (measured: MISS then HIT, 0.13s), so the shards are written there and
// the browser reads them directly. This function is then only the builder, plus
// the fallback for a letter whose object does not exist yet.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const REST = `${Deno.env.get("SUPABASE_URL")}/rest/v1/titles`;
const DIRTY = `${Deno.env.get("SUPABASE_URL")}/rest/v1/shard_dirty`;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const HEADERS = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
// The crawler proves itself with this rather than the service key, which must
// never leave Supabase.
const PUSH_TOKEN = Deno.env.get("PUSH_TOKEN") ?? "";
const STORAGE = `${Deno.env.get("SUPABASE_URL")}/storage/v1/object`;
const BUCKET = "index";
// Bumped with the client's TITLES_SHARD_VERSION: a shape change writes to a new
// prefix instead of overwriting objects that viewers have already cached.
const SHARD_VERSION = 3;
// A letter names its object by codepoint, so a path is plain ASCII whatever the
// alphabet — the index holds 97 distinct initials, Cyrillic and Latin and CJK.
const shardPath = (letter: string) =>
  `v${SHARD_VERSION}/${letter.codePointAt(0)!.toString(16)}.json`;
const fold = (letter: string) => letter.toLowerCase().replace(/ё/, "е");
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// Positional, and the order is the client's contract:
// [name, year, slug, isSeries, embedId, kp, originName]
async function shardRows(folded: string) {
  // Array-contains, not a single initial. A title belongs to the shard of every
  // word it contains, in either language: routing on one initial meant
  // «Пираты Карибского моря» existed only in shard п, so typing «карибского»
  // fetched shard к and the row never reached the matcher — which has always
  // been able to match it.
  const filter = `shard_keys=cs.${encodeURIComponent(`{"${folded}"}`)}`;
  const rows: unknown[] = [];
  // PostgREST caps a page. There is no row cap: shard п is past 19,000 rows and
  // a cap of 20,000 would have started dropping titles without a sound. The id
  // makes the order total, so rows sharing a year and a name cannot swap pages
  // between two requests and be served twice or not at all.
  for (let from = 0; from < 500000; from += 1000) {
    const response = await fetch(
      `${REST}?select=name,origin_name,year,slug,is_series,embed_id,kp&${filter}` +
      `&order=year.desc.nullslast,name.asc,id.asc`,
      { headers: { ...HEADERS, Range: `${from}-${from + 999}` } },
    );
    if (!response.ok) throw new Error(`upstream ${response.status}`);
    const page = await response.json();
    rows.push(...page.map((r: Record<string, unknown>) => [
      r.name, r.year, r.slug, r.is_series ? 1 : 0, r.embed_id, r.kp ?? "", r.origin_name ?? "",
    ]));
    if (page.length < 1000) break;
  }
  return rows;
}

const PUBLISH_TOKEN = Deno.env.get("PUBLISH_TOKEN") ?? "";
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const quote = (value: string) => `"${value}"`;

const RPC = `${Deno.env.get("SUPABASE_URL")}/rest/v1/rpc`;

async function publish(route: string, url: URL, req: Request) {
  if (route === "/sync-state") {
    const endpoint = `${Deno.env.get("SUPABASE_URL")}/rest/v1/titles_sync_state`;
    if (req.method === "GET") {
      const r = await fetch(`${endpoint}?id=eq.lift&select=last_full_at,next_full_page,full_started_at`, { headers: HEADERS });
      if (!r.ok) return json({ error: "state unavailable" }, 502);
      return json((await r.json())[0] || { last_full_at: null });
    }
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") return json({ error: "bad state" }, 400);
    const completed = body.completed === true || !Object.hasOwn(body, "next_full_page");
    const page = Number(body.next_full_page);
    if (!completed && (!Number.isInteger(page) || page < 1 || page > 100000 || !ISO_RE.test(String(body.full_started_at || "")))) {
      return json({ error: "bad checkpoint" }, 400);
    }
    const state = completed
      ? { id: "lift", last_full_at: ISO_RE.test(String(body.full_started_at || "")) ? body.full_started_at : new Date().toISOString(), next_full_page: 1, full_started_at: null }
      : { id: "lift", next_full_page: page, full_started_at: body.full_started_at };
    const r = await fetch(`${endpoint}?on_conflict=id`, { method: "POST",
      headers: { ...HEADERS, Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify(state) });
    return r.ok ? json({ ok: true }) : json({ error: "state unavailable" }, 502);
  }
  // The catalogue sync job (scripts/sync-titles.mjs): a page of the source's
  // listing in, only new or changed titles written.
  if (route === "/catalog" || route === "/fill") {
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    const rows = await req.json().catch(() => null);
    if (!Array.isArray(rows) || rows.length > 1000) return json({ error: "bad batch" }, 400);
    const response = await fetch(`${RPC}/${route === "/catalog" ? "titles_upsert_catalog" : "titles_fill"}`, {
      method: "POST", headers: HEADERS, body: JSON.stringify({ p_rows: rows }),
    });
    if (!response.ok) return json({ error: (await response.text()).slice(0, 300) }, 502);
    const result = await response.json();
    return json(route === "/catalog" ? (Array.isArray(result) ? result[0] : result) : { written: result });
  }
  // Titles still missing their player or Kinopoisk id, newest first: a title the
  // sync has just discovered is resolved within the hour, the old backlog after.
  if (route === "/pending") {
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 100, 1), 1000);
    const response = await fetch(
      `${RPC}/titles_pending`,
      { method: "POST", headers: HEADERS, body: JSON.stringify({ p_limit: limit }) },
    );
    if (!response.ok) return json({ error: "upstream" }, 502);
    return json({ rows: await response.json() });
  }
  if (route === "/letters") {
    const response = await fetch(`${Deno.env.get("SUPABASE_URL")}/rest/v1/shard_letters?select=letter`, { headers: HEADERS });
    if (!response.ok) return json({ error: "upstream" }, 502);
    return json({ letters: (await response.json()).map((row: { letter: string }) => row.letter).filter(Boolean) });
  }
  if (route === "/changes") {
    // Keyset pages over (changed_at, id), so rows sharing a timestamp — the
    // crawler writes whole batches in one statement — are neither skipped nor
    // repeated at a page boundary.
    const afterAt = url.searchParams.get("after_at") ?? "";
    const afterId = Number(url.searchParams.get("after_id") ?? "0");
    if (!ISO_RE.test(afterAt) || !Number.isInteger(afterId) || afterId < 0) return json({ error: "bad cursor" }, 400);
    const filter = `or=(changed_at.gt.${quote(afterAt)},and(changed_at.eq.${quote(afterAt)},id.gt.${afterId}))`;
    const response = await fetch(
      `${REST}?select=id,name,origin_name,year,slug,is_series,embed_id,kp,shard_keys,changed_at` +
      `&${filter}&changed_at=not.is.null&order=changed_at.asc,id.asc&limit=2000`,
      { headers: HEADERS },
    );
    if (!response.ok) return json({ error: await response.text() }, 502);
    const page: Record<string, any>[] = await response.json();
    const last = page[page.length - 1];
    return json({
      // The shard row, then what the publisher needs to place and order it.
      rows: page.map((r) => [
        r.name, r.year, r.slug, r.is_series ? 1 : 0, r.embed_id, r.kp ?? "", r.origin_name ?? "",
        r.shard_keys ?? [], new Date(r.changed_at).toISOString(), r.id,
      ]),
      next: page.length === 2000 && last
        ? { after_at: new Date(last.changed_at).toISOString(), after_id: last.id }
        : null,
    });
  }
  if (route === "/removed") {
    const since = url.searchParams.get("since") ?? "";
    if (!ISO_RE.test(since)) return json({ error: "bad since" }, 400);
    const response = await fetch(
      `${Deno.env.get("SUPABASE_URL")}/rest/v1/shard_removed?select=letter,slug,removed_at` +
      `&removed_at=gt.${encodeURIComponent(since)}&order=removed_at.asc&limit=10000`,
      { headers: HEADERS },
    );
    if (!response.ok) return json({ error: "upstream" }, 502);
    return json({ removed: await response.json() });
  }
  // /pointer: which commit and which index file the browser should read. A few
  // hundred bytes; Storage serves it no-cache, so a move is visible at once.
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  const body = await req.json().catch(() => null);
  if (!/^[0-9a-f]{40}$/.test(String(body?.c || "")) || !/^i\/[0-9a-f]{16}\.json$/.test(String(body?.f || ""))) {
    return json({ error: "bad pointer" }, 400);
  }
  const pointer = JSON.stringify({ v: 1, c: body.c, f: body.f, at: new Date().toISOString() });
  const upload = await fetch(`${STORAGE}/${BUCKET}/pointer.json`, {
    method: "POST",
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", "x-upsert": "true" },
    body: pointer,
  });
  if (!upload.ok) return json({ error: `storage ${upload.status}` }, 502);
  return json({ ok: true, pointer: JSON.parse(pointer) });
}

const json = (body: unknown, status = 200, cache = "no-store") =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": cache },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);

  // Rebuild shards into Storage. Bounded per call — an edge function has a
  // budget and the busiest letter is ten PostgREST pages — so the crawler simply
  // calls it again on its next tick until `remaining` reaches zero.
  if (url.pathname.endsWith("/build")) {
    const pushAllowed = PUSH_TOKEN && req.headers.get("x-push-token") === PUSH_TOKEN;
    const publishAllowed = PUBLISH_TOKEN && req.headers.get("x-publish-token") === PUBLISH_TOKEN;
    if (!pushAllowed && !publishAllowed) {
      return json({ error: "forbidden" }, 403);
    }
    const max = Math.min(Number(url.searchParams.get("max")) || 6, 20);
    const only = (url.searchParams.get("letters") ?? "").trim();
    // The whole queue, which cannot exceed the number of distinct initials. The
    // timestamps are read BEFORE anything is built and remembered, because the
    // delete afterwards is conditional on them — see below.
    // First come, first built. Ordering by the latest mark let letters the
    // crawler touches every tick — the biggest ones — starve behind the rest.
    //
    // And not before a letter has waited an hour. These shards are the fallback
    // now — browsers read jsDelivr, whose bases come from the live table — so a
    // letter the crawler touches every minute need not be rebuilt every twenty:
    // shard п alone is twenty pages of reads each time.
    const settled = new Date(Date.now() - 60 * 60e3).toISOString();
    const queued: { letter: string; marked_at: string }[] = await (await fetch(
      `${DIRTY}?select=letter,marked_at&first_marked_at=lt.${encodeURIComponent(settled)}` +
      `&order=first_marked_at.asc.nullsfirst,letter.asc`, { headers: HEADERS },
    )).json();
    const marks = new Map(queued.map((r) => [r.letter, r.marked_at]));
    // An explicit list is for a full rebuild after a shape change; normally the
    // queue decides, so only letters whose rows actually moved are rewritten.
    const letters = only
      ? [...only].map(fold).filter((l, i, a) => a.indexOf(l) === i).slice(0, max)
      : queued.slice(0, max).map((r) => r.letter);

    const built: string[] = [];
    const failed: string[] = [];
    for (const letter of letters) {
      try {
        const body = JSON.stringify(await shardRows(letter));
        const upload = await fetch(`${STORAGE}/${BUCKET}/${shardPath(letter)}`, {
          method: "POST",
          headers: {
            apikey: KEY, Authorization: `Bearer ${KEY}`,
            "Content-Type": "application/json",
            // A day at the CDN. The client keeps its own copy for a week and a
            // shape change moves to a new prefix, so staleness cannot outlive it.
            "Cache-Control": "public, max-age=86400",
            "x-upsert": "true",
          },
          body,
        });
        if (!upload.ok) throw new Error(`storage ${upload.status}`);
        built.push(letter);
        // Cleared only after the object is written, so a failed build is simply
        // retried on the next tick rather than silently dropping a letter.
        //
        // And only if nothing re-marked the letter since we read the queue. The
        // unconditional delete lost updates: a change landing while a letter was
        // being built found the letter already queued, changed nothing — the
        // insert ignored duplicates — and was then deleted along with the mark it
        // never got to make. The row was in Postgres and in no shard, and nothing
        // would notice until something else happened to touch that letter.
        const mark = marks.get(letter);
        if (mark) {
          const removed = await fetch(
            `${DIRTY}?letter=eq.${encodeURIComponent(letter)}&marked_at=eq.${encodeURIComponent(mark)}`,
            { method: "DELETE", headers: { ...HEADERS, Prefer: "return=representation" } },
          );
          // Re-marked while it was being built: it stays queued, but at the back,
          // so a letter that changes constantly cannot hold the builder forever.
          const gone = removed.ok ? await removed.json() : [];
          if (!Array.isArray(gone) || !gone.length) {
            await fetch(`${DIRTY}?letter=eq.${encodeURIComponent(letter)}`, {
              method: "PATCH",
              headers: { ...HEADERS, Prefer: "return=minimal" },
              body: JSON.stringify({ first_marked_at: new Date().toISOString() }),
            });
          }
        }
      } catch (error) {
        failed.push(`${letter}: ${String(error).slice(0, 80)}`);
      }
    }
    const left = await fetch(`${DIRTY}?select=letter`, {
      headers: { ...HEADERS, Prefer: "count=exact", Range: "0-0" },
    });
    return json({
      built, failed,
      remaining: Number(left.headers.get("content-range")?.split("/")[1] ?? 0),
    });
  }

  // The CDN publisher (a scheduled GitHub job) reads what changed and moves the
  // pointer. Its own token, separate from the crawler's; nothing here is public.
  const publishRoute = ["/letters", "/changes", "/removed", "/pointer", "/catalog", "/pending", "/fill", "/sync-state"]
    .find((route) => url.pathname.endsWith(route));
  if (publishRoute) {
    if (!PUBLISH_TOKEN || req.headers.get("x-publish-token") !== PUBLISH_TOKEN) {
      return json({ error: "forbidden" }, 403);
    }
    return publish(publishRoute, url, req);
  }

  // Ingest, from the Cloudflare crawler only.
  if (req.method === "POST") {
    if (!PUSH_TOKEN || req.headers.get("x-push-token") !== PUSH_TOKEN) {
      return json({ error: "forbidden" }, 403);
    }
    const rows = await req.json();
    if (!Array.isArray(rows) || rows.length > 1000) return json({ error: "bad batch" }, 400);
    const response = await fetch(`${REST}?on_conflict=id`, {
      method: "POST",
      headers: { ...HEADERS, Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(rows),
    });
    if (!response.ok) return json({ error: await response.text() }, 502);
    // Nothing is queued here. Invalidation belongs to the database: a trigger on
    // `titles` marks the shards of every row that changes, so /resolve and any
    // future writer get it for free instead of each having to remember. Working
    // it out here meant /resolve — which writes to the same table — queued
    // nothing at all, and its write-back reached no viewer.
    return json({ ok: true, rows: rows.length });
  }

  // Turn a slug into something playable. The client cannot do this itself:
  // api.zombie-film.live does not resolve from Russia at all, and the index
  // carries a slug precisely so a suggestion is openable before the background
  // backfill has reached it. One call returns the player id and the Kinopoisk
  // id, which is what opening any title costs anyway.
  if (url.pathname.endsWith("/resolve")) {
    const slug = (url.searchParams.get("slug") ?? "").trim();
    if (!/^[a-z0-9-]{1,120}$/i.test(slug)) return json({ error: "bad slug" }, 400);
    // The slug has to be one we already hold, and this is not a formality: the
    // shape of it was the only gate, so any string of letters and dashes drove
    // an unauthenticated, unthrottled request at api.zombie-film.live from our
    // address. This function sat next to a crawler built entirely around not
    // doing that. Now an unknown slug costs the source nothing.
    //
    // It also gives us the row id, so the write below is by primary key. Asking
    // PostgREST to filter on slug instead was a sequential scan of all 81,702
    // rows — 1035ms measured — on the write half of every single resolve.
    const known = await fetch(
      `${REST}?select=id,name,embed_id,kp,origin_name,is_series&slug=eq.${encodeURIComponent(slug)}&limit=1`,
      { headers: HEADERS });
    if (!known.ok) return json({ error: "index unavailable" }, 502);
    const row = (await known.json())[0];
    if (!row) return json({ error: "unknown slug" }, 404);
    // Already resolved: answer from our own table. Every valid slug is public —
    // they are printed in the shards anyone can download — so a resolve that
    // always went upstream was an unmetered way to drive traffic at the source
    // through us, and it also charged a viewer a 1-2s round trip for something
    // we already knew. Reached far more often than it looks, because a viewer's
    // cached shard can be a week older than the table.
    if (row.embed_id) {
      return json({
        slug, embed_id: row.embed_id, kp: row.kp ?? "", name: row.name ?? "",
        origin_name: row.origin_name ?? "", is_series: !!row.is_series, cached: true,
      }, 200, "public, max-age=3600");
    }
    const id = row.id;
    const ask = async (season: string) => {
      const query = new URLSearchParams({ slug, findBy: "init", all: "false", season, _format: "json" });
      const upstream = await fetch(
        `https://api.zombie-film.live/v2/franchise/view/?${query}`,
        { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(15_000) },
      );
      if (!upstream.ok) return null;
      return (await upstream.json())?.view ?? null;
    };
    try {
      let view = await ask("");
      if (!view) return json({ error: "upstream" }, 502);
      // A series answers with video:null until a season is named — the episodes
      // hold the player, not the title. Without this retry every series in the
      // index looked like a title with no player and simply refused to open.
      if (!view.video) {
        const season = await ask("1");
        if (season && Object.keys(season).length) view = { ...view, ...season };
      }
      const embed = Number(String(view.video?.embedUrl || "").match(/\/(\d+)/)?.[1]) || null;
      const raw = String(view.kpId ?? "");
      const kp = /^\d+$/.test(raw) && raw !== "0" ? raw : "";
      if (!embed) return json({ error: "no player for this title" }, 404);
      // Write it back so the next viewer gets it from the index for free. The
      // series flag has to go with it: the crawler only set it on rows it
      // reached, so without this a title stays marked as a film forever even
      // after we have just proved otherwise by resolving its season.
      const isSeries = !!view.season || !!view.seasonLast || [3, 4, 5].includes(Number(view.type));
      await fetch(`${REST}?id=eq.${id}`, {
        method: "PATCH", headers: { ...HEADERS, Prefer: "return=minimal" },
        body: JSON.stringify({
          embed_id: embed, kp,
          // "" rather than null, matching the crawler: null means "never asked",
          // so writing it for a Russian film with no original title put the row
          // straight back into the crawler's pending set — every time, forever.
          origin_name: String(view.originName ?? ""),
          is_series: isSeries,
        }),
      }).catch(() => {});
      return json({
        slug, embed_id: embed, kp,
        name: view.name ?? "", origin_name: view.originName ?? "", is_series: isSeries,
      }, 200, "public, max-age=3600");
    } catch (error) {
      return json({ error: String(error).slice(0, 120) }, 502);
    }
  }

  if (url.pathname.endsWith("/count")) {
    const r = await fetch(`${REST}?select=id`, { headers: { ...HEADERS, Prefer: "count=exact", Range: "0-0" } });
    return json({ rows: Number(r.headers.get("content-range")?.split("/")[1] ?? 0) });
  }

  // A shard. One letter in, every title starting with it out — by its Russian
  // name OR by its original one, so "Good Will…" and "Умница Уилл…" reach the
  // same row. Routing on the Russian initial alone made an English query load a
  // shard the title could not possibly be in, which is why Latin search found
  // nothing at all rather than merely finding less.
  const letter = (url.searchParams.get("i") ?? "").trim();
  if ([...letter].length !== 1) return json({ error: "one letter expected" }, 400);
  const folded = letter.toLowerCase().replace(/ё/, "е");
  // Only reached for a letter whose Storage object is missing — a brand new
  // initial, or the moment right after a version bump. Serve it, and write the
  // object on the way out so the miss happens once for that letter rather than
  // once per viewer: every reader after this one gets the CDN copy and the
  // database stays out of the read path.
  try {
    const rows = await shardRows(folded);
    // Only a letter that actually has titles earns an object. Otherwise any
    // single character anyone asks for would create one.
    if (rows.length) {
      await fetch(`${STORAGE}/${BUCKET}/${shardPath(folded)}`, {
        method: "POST",
        headers: {
          apikey: KEY, Authorization: `Bearer ${KEY}`,
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=86400",
          "x-upsert": "true",
        },
        body: JSON.stringify(rows),
      }).catch(() => { /* serving the reader matters more than the cache */ });
    }
    return json(rows, 200, "public, max-age=86400");
  } catch {
    return json({ error: "upstream" }, 502);
  }
});
