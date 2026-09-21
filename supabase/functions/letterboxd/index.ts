// Letterboxd rating lookup.
//
// Letterboxd has no public API and sends no CORS header on anything, so a
// browser cannot read it directly — that is the only reason a server is here.
//
// Resolution is exact, never by title: letterboxd.com/imdb/<id>/ 302s to the
// film page, and every title we serve already carries an IMDb id. A TV title
// has no Letterboxd page at all, which surfaces as found:false, not an error.
//
// Answers live in this project's own `letterboxd` table. The client shards by a
// hash of the IMDb id, so a film is only ever asked of one project and only that
// project needs to remember it. The table is therefore self-warming: whoever
// looks at a film first pays for the scrape, everyone after reads the row.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS"
};
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " + "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
// A score moves in the second decimal over months. A miss is re-checked sooner:
// it is usually a series and will never resolve, but it can also be a film that
// simply is not on Letterboxd yet.
const FRESH_HIT_MS = 30 * 24 * 3600e3;
const FRESH_MISS_MS = 7 * 24 * 3600e3;
// The film page already carries its popular reviews, so these cost no extra
// request upstream — the same document the rating comes from. Only a handful are
// kept: they are read as a taste of the reception, not as a comment section.
const REVIEW_LIMIT = 6;
const REVIEW_MAX_CHARS = 420;
const REST = `${Deno.env.get("SUPABASE_URL")}/rest/v1/letterboxd`;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const dbHeaders = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json"
};
const json = (body, status = 200, cache = "no-store")=>new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS,
      "Content-Type": "application/json",
      "Cache-Control": cache
    }
  });
const reply = (row, cached, withReviews)=>json(row.found ? {
    imdb: row.imdb,
    found: true,
    slug: row.slug,
    r: row.r,
    n: row.n,
    // Present only when asked for, so a grid never carries the payload. The key
    // existing at all is how a caller tells this version from an older one.
    ...(withReviews ? { reviews: row.reviews ?? [] } : {}),
    cached
  } : {
    imdb: row.imdb,
    found: false,
    ...(withReviews ? { reviews: [] } : {}),
    cached
  }, 200, row.found ? "public, max-age=604800" : "public, max-age=86400");
// The rating sits in the ld+json blob near the end of the document. A regex over
// 40KB keeps this well inside the CPU budget — the second this takes is almost
// entirely waiting on Letterboxd, which is I/O and does not count against it.
function parseRating(html) {
  const value = /"ratingValue":\s*([0-9.]+)/.exec(html);
  if (!value) return null;
  const rating = Number(value[1]);
  if (!Number.isFinite(rating) || rating <= 0 || rating > 5) return null;
  const count = /"ratingCount":\s*(\d+)/.exec(html);
  return {
    r: rating,
    n: count ? Number(count[1]) : null
  };
}
// Letterboxd truncates long reviews itself behind a "more" link, and the tail we
// would keep is a fragment of a sentence. Cut at a boundary instead.
function clip(text, limit) {
  if (text.length <= limit) return { text, clipped: false };
  const cut = text.slice(0, limit);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  const at = stop > limit * 0.5 ? stop + 1 : cut.lastIndexOf(" ");
  return { text: cut.slice(0, at > 0 ? at : limit).trimEnd(), clipped: true };
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', "#039": "'", "#39": "'", nbsp: " ", hellip: "…", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”" };

function decode(text) {
  return text
    .replace(/&(amp|lt|gt|quot|#0?39|nbsp|hellip|mdash|ndash|rsquo|lsquo|ldquo|rdquo);/g,
      (whole, name) => ENTITIES[name] ?? ENTITIES[name.replace(/^#0/, "#")] ?? whole)
    .replace(/&#(\d+);/g, (whole, code) => {
      const point = Number(code);
      return point > 31 && point < 0x10ffff ? String.fromCodePoint(point) : "";
    });
}

// Display names are user-controlled. Bidirectional overrides in one can reorder
// everything rendered after it, so they are stripped rather than escaped: they
// have no legitimate use in a name we show inline.
const stripControls = (text) =>
  text.replace(/[\u0000-\u001f\u007f\u00ad\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "");

// Popular reviews sit in the film page as <article class="production-viewing">.
// Anything unparseable is skipped rather than guessed at.
function parseReviews(html) {
  const start = html.indexOf("Popular reviews");
  if (start < 0) return [];
  const section = html.slice(start, start + 120000);
  const articles = section.match(/<article class="production-viewing[\s\S]*?<\/article>/g) ?? [];
  const out = [];
  for (const article of articles) {
    // js-review-body is the review itself. Matching on "body-text" alone would
    // also match the <p class="body-text ... js-spoiler-container"> warning that
    // precedes a spoiler review, and that paragraph would be served as the text.
    const body = /<div class="[^"]*js-review-body[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(article);
    if (!body) continue;
    let text = decode(body[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    // A "Translate" affordance renders as text once the markup is stripped.
    text = text.replace(/\s*Translate(\s+Translated from[^.]*)?\s*$/i, "").trim();
    if (text.length < 2) continue;
    const name = /<strong class="displayname">([^<]*)<\/strong>/.exec(article);
    const stars = /aria-label="([★½]+)"/.exec(article);
    const author = stripControls(decode(name?.[1] ?? "")).trim().slice(0, 40);
    const clipped = clip(text, REVIEW_MAX_CHARS);
    out.push({
      a: author || null,
      // Stars are halves, so this is the same 0-5 the rating uses.
      r: stars ? stars[1].replace(/½/g, "").length + (stars[1].includes("½") ? 0.5 : 0) : null,
      t: stripControls(clipped.text),
      c: clipped.clipped || /js-review-show-more|reveal-review/.test(article) || undefined,
      // The marker is a warning paragraph beside the body, not a class on the
      // body, so this looks at the whole article. "contains-spoilers" — what
      // this first looked for — appears nowhere and matched nothing, while 2 of
      // the 6 popular reviews on Паразиты and 5 on Бойцовский клуб are spoilers.
      s: /js-spoiler-container/.test(article) || undefined
    });
    if (out.length >= REVIEW_LIMIT) break;
  }
  return out;
}

const fresh = (row)=>{
  const age = Date.now() - new Date(row.updated_at ?? 0).getTime();
  return age < (row.found ? FRESH_HIT_MS : FRESH_MISS_MS);
};
async function readRows(ids) {
  try {
    const list = ids.map((id)=>`"${id}"`).join(",");
    const response = await fetch(`${REST}?imdb=in.(${list})&select=*`, {
      headers: dbHeaders,
      signal: AbortSignal.timeout(4000)
    });
    if (!response.ok) return [];
    return await response.json();
  } catch  {
    // The cache going missing must never take the lookup down with it.
    return [];
  }
}
async function writeRows(rows) {
  if (!rows.length) return;
  try {
    await fetch(`${REST}?on_conflict=imdb`, {
      method: "POST",
      headers: {
        ...dbHeaders,
        Prefer: "resolution=merge-duplicates,return=minimal"
      },
      body: JSON.stringify(rows.map((row)=>({
          ...row,
          updated_at: new Date().toISOString()
        }))),
      signal: AbortSignal.timeout(5000)
    });
  } catch  {}
}
// Returns null when Letterboxd itself could not be reached, which must not be
// written down as a verdict about the film.
async function scrape(imdb) {
  try {
    const upstream = await fetch(`https://letterboxd.com/imdb/${imdb}/`, {
      headers: {
        "User-Agent": UA,
        "Accept-Encoding": "gzip",
        Accept: "text/html"
      },
      redirect: "follow",
      signal: AbortSignal.timeout(9000)
    });
    if (!upstream.ok) return null;
    const html = await upstream.text();
    const parsed = parseRating(html);
    const slug = new URL(upstream.url).pathname.split("/").filter(Boolean).pop() ?? null;
    return {
      imdb,
      found: !!parsed,
      r: parsed?.r ?? null,
      n: parsed?.n ?? null,
      slug: parsed ? slug : null,
      reviews: parsed ? parseReviews(html) : []
    };
  } catch  {
    return null;
  }
}
Deno.serve(async (req)=>{
  if (req.method === "OPTIONS") return new Response("ok", {
    headers: CORS
  });
  if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
  const url = new URL(req.url);
  const raw = url.searchParams.get("imdb")?.trim() ?? "";
  // A caller asking for a batch gets the map shape even when it happens to want
  // exactly one film. Inferring this from a comma made a shard that drew a
  // single id answer in the other shape, and the grid quietly painted nothing.
  const batch = url.searchParams.get("mode") === "batch" || raw.includes(",");
  // Only the watch page asks for these, one film at a time. A batch is a cache
  // lookup by contract and cannot be turned into a reviews scrape by query flags.
  const withReviews = !batch && url.searchParams.get("reviews") === "1";
  const ids = [
    ...new Set(raw.split(",").map((id)=>id.trim()))
  ].filter((id)=>/^tt\d{6,10}$/.test(id)).slice(0, 60);
  if (!ids.length) return json({
    error: "bad imdb id"
  }, 400);
  const known = new Map();
  for (const row of (await readRows(ids))){
    // A row stored before reviews existed is fresh for the rating but has never
    // been asked for reviews; only the single-title watch request may refresh it.
    const needsReviews = withReviews && row.found && !row.reviews;
    if (fresh(row) && !needsReviews) known.set(row.imdb, row);
  }
  // Search/catalog grids are read-only. Scraping every unknown in a cold grid
  // both contradicted the client contract and could fan one page into dozens of
  // Letterboxd requests across the shard ring. Opening a film warms exactly one.
  const missing = batch ? [] : ids.filter((id)=>!known.has(id)).slice(0, 1);
  if (missing.length) {
    const scraped = (await Promise.all(missing.map(scrape))).filter(Boolean);
    for (const row of scraped)known.set(row.imdb, row);
    await writeRows(scraped);
  }
  // A single id keeps the flat shape the watch page reads; a list gets a map.
  if (!batch) {
    const row = known.get(ids[0]);
    return row ? reply(row, !missing.length, withReviews) : json({
      imdb: ids[0],
      found: false,
      unreachable: true
    }, 200, "public, max-age=300");
  }
  const items = {};
  for (const id of ids){
    const row = known.get(id);
    if (row) items[id] = row.found ? {
      r: row.r,
      n: row.n,
      slug: row.slug
    } : null;
  }
  return json({
    items
  }, 200, "public, max-age=3600");
});
