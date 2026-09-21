import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import {
  createKpHandler, hostFor, objectPath, compactPayload, moscowDay, placementGroup,
  OBJECT_HOSTS, FRESH_MS, objectSlot, slotEnd,
} from "../supabase/functions/kp/index.ts";

// The shared Kinopoisk cache: a film is fetched once for everyone. These pin the
// three things that make it safe to put in front of every visitor — one upstream
// call however many ask at once, one budget across keys, and a failure that is
// never published as an answer.

// --- an in-memory stand-in for the Postgres functions in schema.sql ----------
function world({ keys = ["k1", "k2"], upstream, upstreamDelay = 0 } = {}) {
  let clock = Date.parse("2026-09-11T12:00:00Z");
  const rows = new Map();
  const keyDays = new Map();
  const benched = new Set();
  const reports = [];
  const objects = new Map();
  const upstreamCalls = [];
  const iso = (ms) => new Date(ms).toISOString();
  const later = (value) => !!value && Date.parse(value) > clock;

  const rpc = async (name, a) => {
    const key = `${a.p_kind}:${a.p_id}`;
    if (name === "kp_acquire") {
      if (!rows.has(key)) rows.set(key, { status: "pending", version: 0, fresh_until: null, retry_at: null, lease_until: 0, owner: null, host: null });
      const row = rows.get(key);
      const snapshot = () => ({ version: row.version, status: row.status, fresh_until: row.fresh_until, host: row.host, retry_at: row.retry_at });
      const free = row.lease_until < clock;
      const needs = row.status === "pending" || !later(row.fresh_until);
      if (free && needs && !later(row.retry_at)) {
        row.owner = a.p_owner;
        row.lease_until = clock + a.p_lease_seconds * 1000;
        row.version += 1;
        return [{ acquired: true, ...snapshot() }];
      }
      return [{ acquired: false, ...snapshot() }];
    }
    if (name === "kp_complete_v2") {
      const row = rows.get(key);
      if (!row || row.owner !== a.p_owner || row.version !== a.p_version) return false;
      if (a.p_status) row.status = a.p_status;
      if (a.p_host) row.host = a.p_host;
      if (a.p_fresh_until) row.fresh_until = a.p_fresh_until;
      row.retry_at = a.p_retry_at;
      row.owner = null;
      row.lease_until = 0;
      return true;
    }
    if (name === "kp_read") {
      const row = rows.get(key);
      return row ? [{ status: row.status, fresh_until: row.fresh_until, host: row.host, retry_at: row.retry_at, leased: row.lease_until > clock }] : [];
    }
    if (name === "kp_reserve_key") {
      const day = a.p_day;
      const usable = a.p_keys.filter((id) => !benched.has(id) && (keyDays.get(`${id}:${day}`) || 0) < a.p_limit);
      if (!usable.length) return null;
      usable.sort((x, y) => (keyDays.get(`${x}:${day}`) || 0) - (keyDays.get(`${y}:${day}`) || 0));
      keyDays.set(`${usable[0]}:${day}`, (keyDays.get(`${usable[0]}:${day}`) || 0) + 1);
      return usable[0];
    }
    if (name === "kp_key_report") {
      reports.push({ key: a.p_key, status: a.p_status });
      benched.add(a.p_key);
      return null;
    }
    throw new Error(`unexpected rpc ${name}`);
  };

  const handle = createKpHandler({
    rpc,
    keys: async () => keys.map((value) => ({ id: `id-${value}`, value })),
    putObject: async (host, path, body) => { objects.set(`${host}/${path}`, JSON.parse(body)); },
    getObject: async (host, path) => objects.get(`${host}/${path}`) ?? null,
    upstream: async (path, key) => {
      upstreamCalls.push({ path, key });
      for (let i = 0; i < upstreamDelay; i += 1) await new Promise((resolve) => setImmediate(resolve));
      return upstream(path, key);
    },
    now: () => clock,
    // Waiters poll side by side in real life; one shared clock that every
    // waiter pushes forward by a whole poll would exhaust their wait in one lap.
    sleep: async () => { clock += 1; await new Promise((resolve) => setImmediate(resolve)); },
    owner: "worker-a",
  });
  const ask = async (kind, id) => {
    const response = await handle(new Request(`https://x.supabase.co/functions/v1/kp?kind=${kind}&id=${id}`));
    return { status: response.status, body: await response.json() };
  };
  return { ask, rows, objects, upstreamCalls, reports, keyDays, advance: (ms) => { clock += ms; }, iso };
}

const film = (id) => ({ kinopoiskId: Number(id), nameRu: "Интерстеллар", year: 2014 });

test("an unauthorised broker request cannot reserve state or spend a key", async () => {
  let calls = 0;
  const handler = createKpHandler({ token: "server-only", rpc: async () => { calls += 1; } });
  const response = await handler(new Request("https://x/kp?kind=film&id=301"));
  assert.equal(response.status, 403);
  assert.equal(calls, 0);
});

test("a missing film is fetched once, published where the browser will look, and returned", async () => {
  const w = world({ upstream: (path) => ({ status: 200, body: film(path.split("/").pop()) }) });
  const { status, body } = await w.ask("film", "258687");
  assert.equal(status, 200);
  assert.equal(body.v, 1);
  assert.equal(body.status, "ok");
  assert.equal(body.data.nameRu, "Интерстеллар");
  assert.ok(Date.parse(body.freshUntil) > Date.parse(body.fetchedAt));
  assert.ok(Date.parse(body.freshUntil) - Date.parse(body.fetchedAt) <= FRESH_MS.film);
  assert.deepEqual(w.objects.get(`${hostFor("258687")}/${objectPath("film", "258687", objectSlot("film", "258687", Date.parse("2026-09-11T12:00:00Z")))}`), body);
  assert.equal(w.upstreamCalls.length, 1);
  assert.equal(w.upstreamCalls[0].path, "/api/v2.2/films/258687");
});

test("twenty visitors missing the same film at once cost one upstream call", async () => {
  const w = world({ upstreamDelay: 5, upstream: () => ({ status: 200, body: { total: 1, items: [{ filmId: 1 }] } }) });
  const answers = await Promise.all(Array.from({ length: 20 }, () => w.ask("similars", "301")));
  assert.equal(w.upstreamCalls.length, 1);
  assert.ok(answers.every((answer) => answer.status === 202 || (answer.status === 200 && answer.body.data.items[0].filmId === 1)),
    JSON.stringify(answers.map((answer) => answer.status)));
});

test("a fresh object is served from storage without touching the provider again", async () => {
  const w = world({ upstream: () => ({ status: 200, body: film(1) }) });
  await w.ask("film", "1");
  w.advance(3 * 24 * 3600e3);
  const again = await w.ask("film", "1");
  assert.equal(again.status, 200);
  assert.equal(w.upstreamCalls.length, 1);
});

test("a spent key is reported and the next one is used", async () => {
  const w = world({ upstream: (_path, key) => (key === "k1" ? { status: 402, body: null } : { status: 200, body: film(7) }) });
  const { status } = await w.ask("film", "7");
  assert.equal(status, 200);
  assert.deepEqual(w.upstreamCalls.map((call) => call.key), ["k1", "k2"]);
  assert.deepEqual(w.reports, [{ key: "id-k1", status: 402 }]);
});

test("a provider failure is an error, never a published empty answer", async () => {
  const w = world({ upstream: () => ({ status: 500, body: null }) });
  const { status, body } = await w.ask("similars", "9");
  assert.equal(status, 503);
  assert.equal(body.error, "upstream_failed");
  assert.equal(w.objects.size, 0, "nothing may be published");
  const row = w.rows.get("similars:9");
  assert.equal(row.status, "pending");
  assert.ok(Date.parse(row.retry_at) > Date.parse("2026-09-11T12:00:00Z"), "the film backs off before the next try");
  // Asked again during the back-off: no second upstream call.
  const again = await w.ask("similars", "9");
  assert.equal(again.status, 503);
  assert.equal(w.upstreamCalls.length, 1);
});

test("a film the provider does not know is remembered as missing, not as an error", async () => {
  const w = world({ upstream: () => ({ status: 404, body: { message: "not found" } }) });
  const { status, body } = await w.ask("film", "404404");
  assert.equal(status, 200);
  assert.equal(body.status, "missing");
  assert.equal(body.data, null);
  assert.equal(w.objects.size, 0, "a six-hour negative answer must not occupy an immutable month slot");
  assert.equal((await w.ask("film", "404404")).body.status, "missing");
  assert.equal(w.upstreamCalls.length, 1);
});

test("with no keys configured, nothing reaches the provider", async () => {
  const w = world({ keys: [], upstream: () => { throw new Error("must not be called"); } });
  const { status, body } = await w.ask("film", "5");
  assert.equal(status, 503);
  assert.equal(body.error, "no_keys");
});

test("when every key's day is spent, the answer is an error and the film backs off", async () => {
  const w = world({ keys: ["k1"], upstream: () => ({ status: 200, body: film(1) }) });
  for (let i = 0; i < 480; i += 1) w.keyDays.set(`id-k1:${moscowDay(Date.parse("2026-09-11T12:00:00Z"))}`, 480);
  const { status, body } = await w.ask("film", "11");
  assert.equal(status, 503);
  assert.equal(body.error, "budget_exhausted");
  assert.equal(w.upstreamCalls.length, 0);
});

test("only well-formed requests are accepted", async () => {
  const w = world({ upstream: () => { throw new Error("must not be called"); } });
  for (const [kind, id] of [["film", "0"], ["film", "abc"], ["poster", "1"], ["film", "12345678901"], ["film", "-1"]]) {
    assert.equal((await w.ask(kind, id)).status, 400, `${kind} ${id}`);
  }
});

test("staff keeps the directors and actors the site reads, in order, and nothing else", () => {
  const staff = [
    { staffId: 1, nameRu: "Нолан", nameEn: "Nolan", professionKey: "DIRECTOR", description: null, posterUrl: "x" },
    { staffId: 2, nameRu: "Циммер", professionKey: "COMPOSER" },
    ...Array.from({ length: 60 }, (_, i) => ({ staffId: 100 + i, nameRu: `Актёр ${i}`, professionKey: "ACTOR", description: "роль" })),
  ];
  const kept = compactPayload("staff", staff);
  assert.equal(kept[0].professionKey, "DIRECTOR");
  assert.deepEqual(Object.keys(kept[0]).sort(), ["nameEn", "nameRu", "professionKey", "staffId"]);
  assert.ok(!kept.some((person) => person.professionKey === "COMPOSER"));
  assert.equal(kept.filter((person) => person.professionKey === "ACTOR").length, 40);
  assert.equal(kept[1].staffId, 100, "the provider's order is kept");
  // film and similars pass through untouched.
  const payload = { items: [{ filmId: 1 }] };
  assert.equal(compactPayload("similars", payload), payload);
});

test("the daily budget turns over at midnight Moscow time", () => {
  assert.equal(moscowDay(Date.parse("2026-09-11T20:59:59Z")), "2026-09-11");
  assert.equal(moscowDay(Date.parse("2026-09-11T21:00:00Z")), "2026-09-12");
});

// --- the browser side --------------------------------------------------------

async function loadForYou(fetchImpl) {
  const code = await readFile(new URL("../foryou.js", import.meta.url), "utf8");
  const storage = new Map([["alphy.foryou.clientSlot.v1", "0"]]);
  const localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
    key: (index) => [...storage.keys()][index] ?? null,
    get length() { return storage.size; },
  };
  const sandbox = {
    console, Date, JSON, Math, Promise, URL, URLSearchParams, setTimeout, clearTimeout, localStorage, AbortController,
    fetch: fetchImpl,
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
    window: {
      addEventListener: () => {},
      dispatchEvent: () => {},
      alphyBridge: { resolverJson: async (path) => { const response = await fetchImpl(`https://resolver.test${path}`); if (!response.ok) throw new Error("resolver unavailable"); return response.json(); } },
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.window.alphyForYou._test;
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const wrapped = (kind, id, data, { fresh = true, status = "ok" } = {}) => ({
  v: 1, kind, id: Number(id), status,
  fetchedAt: new Date(Date.now() - 1000).toISOString(),
  freshUntil: new Date(Date.now() + (fresh ? 3600e3 : -1000)).toISOString(),
  data,
});

test("the browser looks for a film on the same project the function writes it to", async () => {
  const api = await loadForYou(async () => json({}, 404));
  for (let id = 1; id < 3000; id += 7) {
    assert.equal(api.kpPlacementGroup(String(id)), placementGroup(String(id)));
    assert.equal(api.kpObjectUrl("film", String(id)),
      `https://${hostFor(String(id))}.supabase.co/storage/v1/object/public/kp/${objectPath("film", String(id))}`);
  }
  assert.ok(OBJECT_HOSTS.every((host) => api.kpObjectUrl("film", "1").includes(".supabase.co/")));
});

test("only film, staff, similars and query searches go through the shared cache", async () => {
  const api = await loadForYou(async () => json({}, 404));
  assert.deepEqual({ ...api.sharedTarget("/api/v2.2/films/301") }, { kind: "film", id: "301" });
  assert.deepEqual({ ...api.sharedTarget("/api/v2.2/films/301/similars") }, { kind: "similars", id: "301" });
  assert.deepEqual({ ...api.sharedTarget("/api/v1/staff?filmId=301") }, { kind: "staff", id: "301" });
  assert.deepEqual({ ...api.sharedTarget("/api/v2.1/films/search-by-keyword?keyword=x") }, { kind: "search", q: "x" });
});

test("a published film costs no function call and no key", async () => {
  const calls = [];
  const api = await loadForYou(async (url) => {
    calls.push(String(url));
    return String(url).includes("/storage/v1/object/public/kp/") ? json(wrapped("film", "301", film(301))) : json({}, 500);
  });
  const data = await api.apiGet("/api/v2.2/films/301");
  assert.equal(data.kinopoiskId, 301);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/storage\/v1\/object\/public\/kp\/v2\/film\/301\/\d+\.json$/);
});

test("a missing film is filled by the function, not by this browser's keys", async () => {
  const calls = [];
  const api = await loadForYou(async (url) => {
    calls.push(String(url));
    if (String(url).includes("/storage/")) return json({}, 400);
    if (String(url).includes("resolver.test/kp")) return json(wrapped("staff", "301", [{ staffId: 1, professionKey: "ACTOR" }]));
    throw new Error(`unexpected ${url}`);
  });
  const data = await api.apiGet("/api/v1/staff?filmId=301");
  assert.equal(data[0].staffId, 1);
  assert.ok(calls.some((url) => url.includes("resolver.test/kp?kind=staff&id=301")));
  assert.ok(!calls.some((url) => url.includes("kinopoiskapiunofficial.tech")));
});

test("a total cache outage never fans out to browser keys", async () => {
  const calls = [];
  const api = await loadForYou(async (url) => { calls.push(String(url)); return json({}, 503); });
  await assert.rejects(api.apiGet("/api/v2.2/films/55"), { code: "shared_unavailable" });
  assert.ok(calls.every((url) => url.includes("supabase.co/") || url.includes("resolver.test/kp")));
});

test("a stale copy is used rather than spending this browser's keys when the function is down", async () => {
  const calls = [];
  const api = await loadForYou(async (url) => {
    calls.push(String(url));
    if (String(url).includes("/storage/")) return json(wrapped("similars", "8", { items: [{ filmId: 9 }] }, { fresh: false }));
    return json({ error: "busy" }, 503);
  });
  const data = await api.apiGet("/api/v2.2/films/8/similars");
  assert.equal(data.items[0].filmId, 9);
  assert.ok(!calls.some((url) => url.includes("kinopoiskapiunofficial.tech")));
});

test("a film the provider does not know fails like the provider's own 404", async () => {
  const calls = [];
  const api = await loadForYou(async (url) => {
    calls.push(String(url));
    return String(url).includes("/storage/") ? json(wrapped("film", "404404", null, { status: "missing" })) : json({}, 500);
  });
  await assert.rejects(api.apiGet("/api/v2.2/films/404404"), (error) => error.status === 404);
  assert.equal(calls.length, 1, "nobody asks the provider again");
});

// --- carrying an old film's card forward ------------------------------------
// 86% of the catalogue predates last year; its card barely moves, so it is
// moved into each new weekly slot as it is, spending no key, for sixty days
// from the provider fetch it came from. New releases and running series are
// still fetched every week.
const DAY = 24 * 3600e3;
const START = Date.parse("2026-09-11T12:00:00Z");
const upstreamFilm = (body) => (path) => ({ status: 200, body: { kinopoiskId: Number(path.split("/").pop()), ...body } });

test("an old film's card moves into the new week without spending a key", async () => {
  const w = world({ upstream: upstreamFilm({ year: 1999, type: "FILM" }) });
  const first = await w.ask("film", "301");
  w.advance(8 * DAY);
  const second = await w.ask("film", "301");
  assert.equal(second.status, 200);
  assert.equal(w.upstreamCalls.length, 1, "no provider call");
  assert.equal([...w.keyDays.values()].reduce((a, b) => a + b, 0), 1, "and no key reserved for it");
  assert.equal(second.body.fetchedAt, first.body.fetchedAt, "the age still counts from the provider fetch");
  assert.ok(Date.parse(second.body.freshUntil) > START + 8 * DAY);
  const path = objectPath("film", "301", objectSlot("film", "301", START + 8 * DAY));
  assert.deepEqual(w.objects.get(`${hostFor("301")}/${path}`), second.body, "published where the browser looks this week");
});

test("a carried card is fetched again once its provider fetch is sixty days old", async () => {
  const w = world({ upstream: upstreamFilm({ year: 1999, type: "FILM" }) });
  for (let week = 0; week <= 10; week += 1) {
    assert.equal((await w.ask("film", "301")).status, 200, `week ${week}`);
    w.advance(7 * DAY);
  }
  assert.equal(w.upstreamCalls.length, 2, "day 0, then the first week past sixty days");
});

test("new releases and running series are still fetched every week", async () => {
  for (const body of [
    { year: 2026, type: "FILM" },
    { year: 2025, type: "FILM" },
    { year: 2010, type: "TV_SERIES", completed: false, endYear: null },
    { year: 2012, type: "TV_SERIES", completed: false, endYear: 2025 },
  ]) {
    const w = world({ upstream: upstreamFilm(body) });
    await w.ask("film", "77");
    w.advance(8 * DAY);
    await w.ask("film", "77");
    assert.equal(w.upstreamCalls.length, 2, JSON.stringify(body));
  }
});

test("a finished series is carried like a film; a card that is gone is simply fetched", async () => {
  const series = world({ upstream: upstreamFilm({ year: 2019, type: "MINI_SERIES", serial: false, completed: true }) });
  await series.ask("film", "1294079");
  series.advance(8 * DAY);
  await series.ask("film", "1294079");
  assert.equal(series.upstreamCalls.length, 1);

  const w = world({ upstream: upstreamFilm({ year: 1999, type: "FILM" }) });
  await w.ask("film", "301");
  w.objects.clear();
  w.advance(8 * DAY);
  assert.equal((await w.ask("film", "301")).status, 200);
  assert.equal(w.upstreamCalls.length, 2);
});

test("only a film's card is carried; cast and similar films keep their month", async () => {
  const w = world({ upstream: () => ({ status: 200, body: { total: 1, items: [{ filmId: 1 }] } }) });
  await w.ask("similars", "301");
  w.advance(31 * DAY);
  await w.ask("similars", "301");
  assert.equal(w.upstreamCalls.length, 2);
});

test("which cards last: old films and finished series, never this or last year's", async () => {
  const { lastingFilm } = await import("../supabase/functions/kp/index.ts");
  const now = Date.parse("2026-09-15T00:00:00Z");
  const fresh = now - DAY;
  assert.equal(lastingFilm({ year: 2024, type: "FILM" }, fresh, now), true);
  assert.equal(lastingFilm({ year: 2025, type: "FILM" }, fresh, now), false);
  assert.equal(lastingFilm({ year: null, type: "FILM" }, fresh, now), false, "an unknown year is treated as new");
  assert.equal(lastingFilm({ year: 2015, type: "TV_SERIES", completed: false, endYear: 2019 }, fresh, now), true);
  assert.equal(lastingFilm({ year: 2015, type: "TV_SHOW", completed: false }, fresh, now), false);
  assert.equal(lastingFilm({ year: 2015, type: "FILM" }, now - 61 * DAY, now), false);
  assert.equal(lastingFilm(null, fresh, now), false);
});

test("a card in a row takes last week's copy; only the film's own page asks for a fresh one", async () => {
  const calls = [];
  const api = await loadForYou(async (url) => {
    calls.push(String(url));
    const href = String(url);
    if (href.includes("resolver.test/kp")) return json(wrapped("film", "501", { kinopoiskId: 501, year: 2026, rating: { kp: 8 } }));
    if (!href.includes("/storage/")) throw new Error(`unexpected ${href}`);
    // Only the previous weekly slot holds a copy.
    return href === api.kpObjectUrl("film", "501", { previous: true }) || href === api.kpObjectUrl("film", "501", { replica: true, previous: true })
      ? json(wrapped("film", "501", { kinopoiskId: 501, year: 2026, ratingKinopoisk: 7.5 }, { fresh: false }))
      : json({}, 400);
  });
  const cards = await api.fetchMetaBatch(["501"]);
  assert.ok(cards.get("501"), "the row card is painted from last week's copy");
  assert.ok(!calls.some((url) => url.includes("resolver.test")), "and asks nobody to refresh it");

  const page = await api.apiGet("/api/v2.2/films/501");
  assert.equal(page.rating.kp, 8, "the film's page gets the refreshed card");
  assert.ok(calls.some((url) => url.includes("resolver.test/kp?kind=film&id=501")));
});

test("a card with no copy at all is still filled", async () => {
  const calls = [];
  const api = await loadForYou(async (url) => {
    calls.push(String(url));
    if (String(url).includes("/storage/")) return json({}, 400);
    return json(wrapped("film", "502", { kinopoiskId: 502, year: 1990 }));
  });
  assert.ok((await api.fetchMetaBatch(["502"])).get("502"));
  assert.equal(calls.filter((url) => url.includes("resolver.test/kp?kind=film&id=502")).length, 1);
});
