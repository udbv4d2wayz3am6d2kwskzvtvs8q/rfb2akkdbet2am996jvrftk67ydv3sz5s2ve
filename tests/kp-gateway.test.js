import test from "node:test";
import assert from "node:assert/strict";
import { createKpGateway } from "../resolver-deno/kp-gateway.js";
const object = (kind = "film", id = 1) => ({ v: 1, kind, id, status: "ok", freshUntil: new Date(Date.now() + 3600e3).toISOString(), data: { kinopoiskId: id, description: "Synopsis", ratingKinopoisk: 8 } });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });

test("equivalent searches share one stored query across resolver instances", async () => {
  const { objectPath, objectSlot, hostFor } = await import("../supabase/functions/kp/index.ts");
  const query = "матрица фильм";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(query));
  const id = parseInt(Buffer.from(digest).subarray(0, 6).toString("hex"), 16) + 1;
  const expected = `https://${hostFor(id)}.supabase.co/storage/v1/object/public/kp/${objectPath("search", id, objectSlot("search", id))}`;
  let calls = 0;
  const fetcher = async (url) => {
    assert.equal(String(url), expected); calls += 1;
    return json({ v: 1, kind: "search", id, query, status: "ok", freshUntil: new Date(Date.now() + 60000).toISOString(), data: { films: [{ filmId: 301 }] } });
  };
  for (const q of ["  МАТРИЦА   фильм  ", "матрица фильм"]) {
    const result = await createKpGateway({ token: "private", fetcher })(new Request(`https://x/kp?kind=search&q=${encodeURIComponent(q)}`));
    assert.equal((await result.json()).data.films[0].filmId, 301);
  }
  assert.equal(calls, 2);
});

test("10,000 identical cold requests invoke the broker once, then stay in cache", async () => {
  let brokerCalls = 0;
  let storageCalls = 0;
  const handle = createKpGateway({ token: "private", fetcher: async (url, init) => {
    if (url.includes("/storage/")) { storageCalls += 1; return json({}, 404); }
    brokerCalls += 1;
    assert.equal(init.headers["x-kp-token"], "private");
    await new Promise((resolve) => setImmediate(resolve));
    return json(object());
  } });
  const responses = await Promise.all(Array.from({ length: 10000 }, () => handle(new Request("https://resolver.test/kp?kind=film&id=1"))));
  for (const r of responses) assert.equal((await r.json()).data.kinopoiskId, 1);
  assert.equal(brokerCalls, 1);
  assert.equal(storageCalls, 2);
  await handle(new Request("https://resolver.test/kp?kind=film&id=1"));
  assert.equal(brokerCalls, 1);
});

test("a new resolver instance reads the persistent shared cache", async () => {
  const entries = new Map();
  const cache = { match: async (req) => entries.get(req.url)?.clone(), put: async (req, r) => { entries.set(req.url, r.clone()); } };
  let calls = 0;
  const fetcher = async (url) => { if (url.includes("/storage/")) return json({}, 404); calls += 1; return json(object()); };
  const ask = () => new Request("https://x/kp?kind=film&id=1");
  await createKpGateway({ cache, token: "x", fetcher })(ask());
  const again = await createKpGateway({ cache, token: "x", fetcher })(ask());
  assert.equal((await again.json()).data.description, "Synopsis");
  assert.equal(calls, 1);
});

test("another instance filling a title causes object polling, not SQL or repeated Functions", async () => {
  let reads = 0;
  let fills = 0;
  const handle = createKpGateway({ token: "x", sleep: async () => {}, fetcher: async (url) => {
    if (url.includes("/storage/")) return ++reads > 2 ? json(object()) : json({}, 404);
    fills += 1; return json({ error: "busy" }, 202);
  } });
  const result = await handle(new Request("https://x/kp?kind=film&id=1"));
  assert.equal(result.status, 200);
  assert.equal(fills, 1);
});

test("failed upstream never becomes a cached missing film", async () => {
  let writes = 0;
  const handle = createKpGateway({ token: "x", cache: { match: async () => null, put: async () => { writes += 1; } },
    sleep: async () => {}, fetcher: async () => json({}, 503) });
  assert.equal((await handle(new Request("https://x/kp?kind=film&id=1"))).status, 503);
  assert.equal(writes, 0);
});

test("malformed input spends no network calls", async () => {
  const handle = createKpGateway({ fetcher: async () => { throw new Error("must not run"); } });
  for (const path of ["?kind=film&id=-1", "?kind=arbitrary&id=1", "?kind=search&q="]) {
    assert.equal((await handle(new Request(`https://x/kp${path}`))).status, 400);
  }
});

test("a stale answer survives an outage without hammering the broker on every visit", async () => {
  let now = Date.now(), fills = 0;
  const handle = createKpGateway({ now: () => now, token: "x", fetcher: async (url) => {
    if (url.includes("/storage/")) return json({}, 404);
    return ++fills === 1 ? json(object()) : json({}, 503);
  } });
  const ask = () => handle(new Request("https://x/kp?kind=film&id=1"));
  await ask();
  now += 2 * 3600e3;
  assert.equal((await (await ask()).json()).data.description, "Synopsis");
  await ask(); await ask();
  assert.equal(fills, 2);
});

test("many different cold titles are bounded while same-title waiters share work", async () => {
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const handle = createKpGateway({ maxInflight: 1, token: "x", fetcher: async (url) => {
    if (url.includes("/storage/")) return json({}, 404);
    await waiting; return json(object());
  } });
  const first = handle(new Request("https://x/kp?kind=film&id=1"));
  const same = handle(new Request("https://x/kp?kind=film&id=1"));
  assert.equal((await handle(new Request("https://x/kp?kind=film&id=2"))).status, 503);
  release();
  assert.equal((await first).status, 200);
  assert.equal((await same).status, 200);
});
