import test from "node:test";
import assert from "node:assert/strict";

import {
  createZonaHandler, objectPath, objectSlot, placementGroup, slotEnd,
} from "../supabase/functions/zona/index.ts";

const NOW = Date.UTC(2026, 8, 21, 12);
const ID = "301";
const answer = {
  zenithId: "777",
  zenithIds: ["777"],
  embedUrl: "https://api.zenithjs.ws/embed/movie/777",
};

function harness({ existing = null, acquired = true } = {}) {
  let stored = existing;
  const calls = { rpc: [], resolve: 0, puts: [] };
  const handle = createZonaHandler({
    now: () => NOW,
    owner: "test-owner",
    async rpc(name, args) {
      calls.rpc.push([name, args]);
      if (name === "zona_acquire") return [{ acquired, version: 4, status: "pending" }];
      return true;
    },
    async getObject() { return stored; },
    async putObject(path, body) { calls.puts.push(path); stored = JSON.parse(body); },
    async resolve() { calls.resolve += 1; return answer; },
  });
  return { handle, calls, get stored() { return stored; } };
}

test("Zona placement and immutable slot path are stable", () => {
  assert.equal(placementGroup(ID), placementGroup(ID));
  const slot = objectSlot(ID, NOW);
  assert.equal(objectPath(ID, slot), `v1/${ID}/${slot}.json`);
  assert.ok(slotEnd(ID, slot) > NOW);
  assert.ok(slotEnd(ID, slot) - NOW <= 30 * 24 * 3600e3);
});

test("a cold Zona identity is resolved once and published", async () => {
  const h = harness();
  const response = await h.handle(new Request(`https://edge.test/zona?kpId=${ID}`));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.embedUrl, answer.embedUrl);
  assert.equal(h.calls.resolve, 1);
  assert.deepEqual(h.calls.puts, [objectPath(ID, objectSlot(ID, NOW))]);
  assert.deepEqual(h.calls.rpc.map(([name]) => name), ["zona_acquire", "zona_complete"]);
});

test("a public Storage hit spends neither SQL nor mzona", async () => {
  const freshUntil = new Date(slotEnd(ID, objectSlot(ID, NOW))).toISOString();
  const h = harness({ existing: { v: 1, kpId: Number(ID), ...answer, freshUntil } });
  const response = await h.handle(new Request(`https://edge.test/zona?kpId=${ID}`));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).cached, true);
  assert.equal(h.calls.resolve, 0);
  assert.deepEqual(h.calls.rpc, []);
});

test("another isolate holding the lease returns busy without a second resolve", async () => {
  const h = harness({ acquired: false });
  const response = await h.handle(new Request(`https://edge.test/zona?kpId=${ID}`));
  assert.equal(response.status, 202);
  assert.equal(h.calls.resolve, 0);
  assert.equal(h.calls.rpc.length, 1);
});

test("malformed and poisoned identities are never served", async () => {
  const freshUntil = new Date(slotEnd(ID, objectSlot(ID, NOW))).toISOString();
  const h = harness({ existing: {
    v: 1, kpId: Number(ID), zenithId: "777",
    embedUrl: "https://evil.example/embed/movie/777", freshUntil,
  } });
  const response = await h.handle(new Request(`https://edge.test/zona?kpId=${ID}`));
  assert.equal(response.status, 200, "the bad cache entry is ignored and replaced");
  assert.equal(h.calls.resolve, 1);

  const bad = await h.handle(new Request("https://edge.test/zona?kpId=abc"));
  assert.equal(bad.status, 400);
});
