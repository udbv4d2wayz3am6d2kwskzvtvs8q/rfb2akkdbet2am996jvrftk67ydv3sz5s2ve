import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { catalogRow, fillPending, fillRow, fullScanDue, net, syncCatalog, runSync, SoftError, SPACING_MS, UA } from "../scripts/sync-titles.mjs";

// The scheduled job that replaces the Cloudflare crawler's frozen catalogue. These
// pin how it treats the source — one request at a time, paced, stopping at the
// first 429 — and that it recognises the end of a listing that never ends.

const requestTitles = net.titles;
const item = (id, year = 2026) => ({ id, name: `Тайтл ${id}`, year, type: 1, slug: `t-${id}`, rate: { kinopoisk: 7.1 } });

function fake({ pages = [], total = 0, writes = () => ({ inserted: 0, updated: 0 }), views = {}, pending = [] } = {}) {
  const calls = { source: [], titles: [], sleeps: [] };
  net.token = "t";
  let clock = 0;
  net.now = () => clock;
  net.sleep = async (ms) => { calls.sleeps.push(ms); clock += ms; };
  net.source = async (url, { soft } = {}) => {
    calls.source.push(url);
    const u = new URL(url);
    if (u.pathname.endsWith("/search/")) {
      const page = Number(u.searchParams.get("page"));
      // Past the end the API repeats its last page.
      return { items: pages[Math.min(page, pages.length) - 1] || [], totalCount: total };
    }
    const answer = views[`${u.searchParams.get("slug")}|${u.searchParams.get("season")}`];
    if (answer instanceof Error) throw answer;
    if (answer === "soft") throw new SoftError("http 500");
    if (!soft) throw new Error("views are always soft");
    return answer ?? { view: {} };
  };
  net.titles = async (route, body) => {
    calls.titles.push({ route, body });
    if (route === "/catalog") return writes(body);
    if (route.startsWith("/pending")) return { rows: pending };
    return { written: body.length };
  };
  return calls;
}

test("a listing row keeps only what the index stores", () => {
  assert.deepEqual(catalogRow(item(5)), { id: 5, name: "Тайтл 5", year: 2026, type: 1, slug: "t-5", rate_kp: 7.1, source_revision: "[null,null,null,null,null]" });
  assert.equal(catalogRow({ id: 1, name: "x" }).rate_kp, null);
});

test("the full read stops where the listing repeats its last page", async () => {
  const pages = [[item(3), item(2)], [item(1)]];
  const calls = fake({ pages, total: 0 });
  const stats = await syncCatalog({ full: true });
  assert.equal(stats.pages, 2);
  assert.equal(stats.reachedEnd, true);
  assert.equal(calls.source.length, 3, "one extra page shows the repeat, and no more");
  assert.deepEqual(calls.titles.map((call) => call.route), ["/catalog", "/catalog"]);
});

test("a partial full scan saves progress and leaves time to fill new titles", async () => {
  const calls = fake({ pages: Array.from({ length: 200 }, (_, i) => [item(1000 - i)]),
    pending: [{ id: 1, slug: "film" }], views: { "film|": { view: { kpId: 301, video: { embedUrl: "https://x/embed/movie/77" } } } } });
  const original = net.titles;
  let checkpoint = { last_full_at: null, next_full_page: 1, full_started_at: "2026-09-12T21:51:35+00:00" };
  net.titles = async (route, body) => {
    if (route === "/sync-state") { if (body) checkpoint = body; return checkpoint; }
    if (route.startsWith("/build")) return { built: [], remaining: 0 };
    return original(route, body);
  };
  const result = await runSync({ budgetMin: 1, fillLimit: 1 });
  assert.equal(result.catalog.reachedEnd, false);
  assert.equal(result.fill.filled, 1, "catalogue scanning cannot consume the fill budget");
  assert.ok(checkpoint.next_full_page > 1);
  assert.ok(checkpoint.full_started_at);
  assert.equal(checkpoint.full_started_at, "2026-09-12T21:51:35.000Z", "PostgREST timestamps are normalized for the checkpoint API");
  const resume = checkpoint.next_full_page;
  const next = fake({ pages: Array.from({ length: 200 }, (_, i) => [item(1000 - i)]) });
  const resumed = await syncCatalog({ full: true, startPage: resume, deadline: 5000 });
  assert.equal(Number(new URL(next.source[0]).searchParams.get("page")), resume);
  assert.ok(resumed.nextPage > resume);
  assert.ok(calls.titles.some((x) => x.route === "/fill"));
});

test("the head read stops after three pages in a row that change nothing", async () => {
  const pages = Array.from({ length: 30 }, (_, i) => [item(1000 - i)]);
  let page = 0;
  const calls = fake({ pages, writes: () => (++page <= 2 ? { inserted: 1, updated: 0 } : { inserted: 0, updated: 0 }) });
  const stats = await syncCatalog({ full: false });
  assert.equal(stats.pages, 5, "two pages with news, then three quiet ones");
  assert.equal(stats.inserted, 2);
  assert.ok(calls.sleeps.every((ms) => ms === SPACING_MS));
  assert.equal(calls.sleeps.length, stats.pages - 1, "every request after the first is spaced");
});

test("a title is resolved from its own page, a series by naming its first season", async () => {
  const views = {
    "film|": { view: { kpId: 258687, video: { embedUrl: "https://x/embed/movie/180" }, originName: "Interstellar" } },
    "show|": { view: { kpId: 0, video: null } },
    "show|1": { view: { kpId: "0", video: { embedUrl: "https://x/embed/tv/77" }, originName: "", season: { id: 1 } } },
  };
  const calls = fake({ views, pending: [{ id: 1, slug: "film" }, { id: 2, slug: "show" }] });
  const stats = await fillPending({ limit: 10 });
  assert.equal(stats.filled, 2);
  const written = calls.titles.find((call) => call.route === "/fill").body;
  assert.deepEqual(written[0], { id: 1, kp: "258687", embed_id: 180, origin_name: "Interstellar", is_series: false });
  assert.deepEqual(written[1], { id: 2, kp: "", embed_id: 77, origin_name: "", is_series: true },
    "no Kinopoisk id is recorded as none, not left unasked");
});

test("a broken title counts a try; five in a row end the run", async () => {
  const pending = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, slug: `bad-${i}` }));
  const views = Object.fromEntries(pending.map((row) => [`${row.slug}|`, "soft"]));
  const calls = fake({ views, pending });
  const stats = await fillPending({ limit: 10 });
  assert.equal(stats.asked, 5);
  assert.equal(stats.failed, 5);
  const written = calls.titles.find((call) => call.route === "/fill").body;
  assert.ok(written.every((row) => row.failed === true));
});

test("a 429 ends the run at once, and what was resolved before it is still written", async () => {
  const views = {
    "a|": { view: { kpId: 1, video: { embedUrl: "https://x/embed/movie/1" } } },
    "b|": new Error("429 rate limited"),
  };
  const calls = fake({ views, pending: [{ id: 1, slug: "a" }, { id: 2, slug: "b" }, { id: 3, slug: "c" }] });
  const stats = await fillPending({ limit: 10 });
  assert.equal(stats.stoppedBy, "429 rate limited");
  assert.equal(stats.asked, 2);
  assert.deepEqual(calls.titles.find((call) => call.route === "/fill").body.map((row) => row.id), [1]);
});

test("the resolved row is shaped exactly as the table expects", () => {
  assert.deepEqual(fillRow(9, {}), { id: 9, kp: "", embed_id: null, origin_name: "", is_series: false });
});

test("the job announces itself and checks the durable full-scan checkpoint", async () => {
  assert.match(UA, /alphy\.tv; contact:/);
  const workflow = await readFile(new URL("../.github/workflows/titles-sync.yml", import.meta.url), "utf8");
  assert.match(workflow, /cron: "5 \*\/2 \* \* \*"/);
  assert.match(workflow, /--auto/);
  assert.match(workflow, /SEARCH_PUBLISH_TOKEN/);
});

test("a delayed scheduled run still detects an overdue full scan", async () => {
  const now = Date.parse("2026-09-12T08:48:00Z");
  net.now = () => now;
  net.titles = async () => ({ last_full_at: new Date(now - 5 * 3600e3).toISOString() });
  assert.equal(await fullScanDue(), true);
  net.titles = async () => ({ last_full_at: new Date(now - 3 * 3600e3).toISOString() });
  assert.equal(await fullScanDue(), false);
  net.titles = async () => ({ last_full_at: null });
  assert.equal(await fullScanDue(), true);
});


test("empty optional season preserves the real series card instead of stopping the run", async () => {
  const calls = fake({ views: {
    "nepriznanie|": { view: { id: 116625, kpId: "1294079", type: 3, originName: "Disclaimer" } },
    "nepriznanie|1": { view: {} },
  }, pending: [{ id: 116625, slug: "nepriznanie" }] });
  const stats = await fillPending();
  assert.equal(stats.filled, 1); assert.equal(stats.failed, 0); assert.equal(stats.stoppedBy, "");
  const row = calls.titles.find(c => c.route === "/fill").body[0];
  assert.equal(row.kp, "1294079"); assert.equal(row.origin_name, "Disclaimer");
  assert.equal(row.is_series, true); assert.equal(row.embed_id, null);
});


test("transient catalogue gateway failures retry, but non-idempotent fill is never replayed", async (t) => {
  net.sleep = async () => {};
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => ++calls === 1
    ? new Response("temporary", { status: 502 })
    : new Response(JSON.stringify({ inserted: 1 }), { status: 200 }));
  assert.equal((await requestTitles("/catalog", [{ id: 1 }])).inserted, 1);
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(requestTitles("/fill", [{ id: 1, failed: true }]), /502/);
  assert.equal(calls, 1);
});
