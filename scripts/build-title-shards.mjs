// Full rebuild of the search-index shards into Supabase Storage.
//
// Day to day nothing runs this: a trigger on `titles` marks the shards of every
// row that changes and the `titles` function rebuilds only those. This is the operator
// path — a shape change, a new mirror project, or a bucket that was emptied —
// and it is deliberately a plain script rather than a function, because a full
// build is ~100 letters of ten PostgREST pages each and has no business inside a
// request budget.
//
//   SUPABASE_SERVICE_ROLE_KEY=… node scripts/build-title-shards.mjs [--letters=абв]
//
// And to add a mirror — another Supabase account serving the same shards, which
// is how free egress is multiplied and how one project going down stops being an
// outage. A mirror needs no database and no function, only the bucket: the
// objects are copied from the primary as they are.
//
//   SUPABASE_SERVICE_ROLE_KEY=<the MIRROR's key> \
//     node scripts/build-title-shards.mjs --mirror=<mirror-ref>
//
// then add its public bucket URL to TITLES_SHARD_HOSTS in app.js. Letters are
// routed across whatever is in that list, so a mirror starts carrying traffic
// as soon as it is listed.
//
// The key is read from the environment and never written anywhere.

const args = new Map(process.argv.slice(2)
  .filter((a) => a.startsWith("--"))
  .map((a) => a.replace(/^--/, "").split("=")));

// Where the shards are built from, and read from when mirroring.
const PRIMARY = "xoathqkggcuyoyutxwri";
const MIRROR = args.get("mirror") || "";
const REF = MIRROR || args.get("project") || PRIMARY;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const BUCKET = "index";
// Must match TITLES_SHARD_VERSION in app.js and SHARD_VERSION in the function.
const SHARD_VERSION = 3;
const BASE = `https://${REF}.supabase.co`;
const HEADERS = { apikey: KEY, Authorization: `Bearer ${KEY}` };

// Reading the letter list off the primary while writing to a mirror needs the
// primary's key too; without it, pass --letters and skip the lookup.
const PRIMARY_KEY = process.env.SUPABASE_PRIMARY_KEY || "";

if (!KEY) {
  console.error("SUPABASE_SERVICE_ROLE_KEY is required");
  process.exit(1);
}
if (MIRROR && !args.has("letters") && !PRIMARY_KEY) {
  console.error("mirroring needs --letters, or SUPABASE_PRIMARY_KEY to look them up");
  process.exit(1);
}

// A letter names its object by codepoint, so the path is plain ASCII whatever
// the alphabet. The index is keyed by 97 distinct letters — Cyrillic, Latin, CJK.
const shardPath = (letter) => `v${SHARD_VERSION}/${letter.codePointAt(0).toString(16)}.json`;
const fold = (letter) => letter.toLowerCase().replace(/ё/, "е");

async function rows(letter) {
  // Every word's first letter, not just the title's — see schema.sql.
  const filter = `shard_keys=cs.${encodeURIComponent(`{"${letter}"}`)}`;
  const out = [];
  for (let from = 0; from < 20000; from += 1000) {
    const response = await fetch(
      `${BASE}/rest/v1/titles?select=name,origin_name,year,slug,is_series,embed_id,kp&${filter}` +
      `&order=year.desc.nullslast,name.asc`,
      { headers: { ...HEADERS, Range: `${from}-${from + 999}` } },
    );
    if (!response.ok) throw new Error(`rest ${response.status}`);
    const page = await response.json();
    // Positional, and the order is the client's contract:
    // [name, year, slug, isSeries, embedId, kp, originName]
    out.push(...page.map((r) => [
      r.name, r.year, r.slug, r.is_series ? 1 : 0, r.embed_id, r.kp ?? "", r.origin_name ?? "",
    ]));
    if (page.length < 1000) break;
  }
  return out;
}

async function upload(letter, body) {
  const response = await fetch(`${BASE}/storage/v1/object/${BUCKET}/${shardPath(letter)}`, {
    method: "POST",
    headers: {
      ...HEADERS,
      "Content-Type": "application/json",
      // A day at the CDN. The browser keeps its own copy for a week, and a shape
      // change moves to a new prefix, so staleness cannot outlive either.
      "Cache-Control": "public, max-age=86400",
      "x-upsert": "true",
    },
    body,
  });
  if (!response.ok) throw new Error(`storage ${response.status} ${await response.text()}`);
}

// A bucket the mirror does not have yet. Public, because a public object is
// CDN-cached and a signed one is not, which is the entire point.
if (MIRROR) {
  const created = await fetch(`${BASE}/storage/v1/bucket`, {
    method: "POST",
    headers: { ...HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: true, file_size_limit: 10485760 }),
  });
  if (!created.ok && created.status !== 409) {
    console.error(`bucket: ${created.status} ${await created.text()}`);
    process.exit(1);
  }
}

const letters = args.has("letters")
  ? [...args.get("letters")].map(fold)
  : await (async () => {
    // The `shard_letters` view, not `titles`: PostgREST caps a plain select at
    // 1000 rows, so asking the table for its initials answers with the letters
    // of the first thousand titles — 23 of 86 — and the rest are never built.
    // Always asked of the primary: a mirror holds objects, not rows.
    const response = await fetch(
      `https://${PRIMARY}.supabase.co/rest/v1/shard_letters?select=letter`,
      { headers: MIRROR ? { apikey: PRIMARY_KEY, Authorization: `Bearer ${PRIMARY_KEY}` } : HEADERS },
    );
    if (!response.ok) throw new Error(`rest ${response.status}`);
    return (await response.json()).map((r) => r.letter).sort();
  })();

// A mirror copies the primary's objects rather than rebuilding them, so every
// host is byte-identical and a viewer cannot get two different answers depending
// on which one the ring sent them to.
async function copyFromPrimary(letter) {
  const response = await fetch(
    `https://${PRIMARY}.supabase.co/storage/v1/object/public/${BUCKET}/${shardPath(letter)}`);
  if (!response.ok) throw new Error(`primary ${response.status}`);
  return response.text();
}

// Read before building, for the same reason the function does: the delete after
// an upload is conditional on the mark not having moved, so a change that lands
// mid-build leaves the letter queued instead of being deleted along with it.
const marks = new Map(MIRROR ? [] : (await (await fetch(
  `${BASE}/rest/v1/shard_dirty?select=letter,marked_at`, { headers: HEADERS },
)).json()).map((r) => [r.letter, r.marked_at]));

console.log(`${letters.length} letters -> ${BASE}/storage/v1/object/public/${BUCKET}/v${SHARD_VERSION}/`);
let bytes = 0;
let biggest = { letter: "", kb: 0 };
for (const letter of letters) {
  const body = MIRROR ? await copyFromPrimary(letter) : JSON.stringify(await rows(letter));
  await upload(letter, body);
  bytes += body.length;
  const kb = Math.round(body.length / 1024);
  if (kb > biggest.kb) biggest = { letter, kb };
  process.stdout.write(`  ${letter} ${kb}KB\n`);
  // Clear the queue entry, but only if nothing re-marked the letter while it was
  // being built. A mirror has no queue — it has no database at all.
  const mark = marks.get(letter);
  if (!MIRROR && mark) {
    await fetch(
      `${BASE}/rest/v1/shard_dirty?letter=eq.${encodeURIComponent(letter)}` +
      `&marked_at=eq.${encodeURIComponent(mark)}`,
      { method: "DELETE", headers: { ...HEADERS, Prefer: "return=minimal" } }).catch(() => {});
  }
}
console.log(`done: ${Math.round(bytes / 1024)}KB total, biggest ${biggest.letter} ${biggest.kb}KB`);
