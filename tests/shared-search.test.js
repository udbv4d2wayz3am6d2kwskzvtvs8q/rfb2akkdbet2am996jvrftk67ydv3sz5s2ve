import test from "node:test";
import assert from "node:assert/strict";
import { makeSandbox, sleep } from "./helpers/app-sandbox.js";

test("a nearly expired shared search does not get another six hours in localStorage", async () => {
  const ctx = makeSandbox(); ctx.run(); await sleep(80);
  const expires = Date.now() + 60000;
  ctx.sandbox.window.alphyForYou = { unofficialGet: async () => ({ films: [], __alphyFreshUntil: expires }) };
  await ctx.sandbox.window.alphyBridge._test.searchPoiskkino("near-end");
  const cached = JSON.parse(ctx.storage.get("alphy.cache.search:near-end|"));
  assert.ok(cached.exp <= expires + 10);
  assert.ok(cached.exp > Date.now());
});

test("Enter can discover an external title absent from Lift without blocking on film metadata", async () => {
  const ctx = makeSandbox();
  ctx.run();
  await sleep(80);
  const calls = [];
  ctx.sandbox.window.alphyForYou = { unofficialGet: async (path) => {
    calls.push(path);
    assert.match(path, /^\/api\/v2\.1\/films\/search-by-keyword\?/);
    return { films: [{ filmId: 987654, nameRu: "Новый внешний фильм", year: "2026", type: "FILM", rating: "8.1" }] };
  } };
  ctx.sandbox.fetch = async () => { throw new Error("Lift index is unavailable"); };
  const search = ctx.sandbox.window.alphyBridge._test.searchPoiskkino;
  const result = await search("Новый внешний фильм");
  assert.equal(String(result[0].kpId), "987654");
  assert.equal(result[0].metaLevel, "summary");
  assert.equal(calls.length, 1);
  const repeated = await search("Новый внешний фильм");
  assert.equal(String(repeated[0].kpId), "987654");
  assert.equal(calls.length, 1, "repeat Enter uses the browser query cache");
});
