import test from "node:test";
import assert from "node:assert/strict";
import { deletableObjects, expiredObject } from "../scripts/clean-kp-cache.mjs";
import { objectSlot, RENEW_MS } from "../supabase/functions/kp/index.ts";

test("cache maintenance keeps the current/previous slots and never touches unrelated data", () => {
  const now = Date.parse("2026-09-12T05:00:00Z");
  for (const kind of ["film", "staff", "similars", "search"]) {
    const slot = objectSlot(kind, "301", now);
    const path = (s) => `v2/${kind}/301/${s}.json`;
    assert.equal(expiredObject(path(slot), now), false);
    assert.equal(expiredObject(path(slot - 1), now), false);
    assert.equal(expiredObject(path(slot - 2), now), true);
    assert.equal(expiredObject(path(slot + 1), now), false);
  }
  for (const name of ["v1/film/301.json", "catalog.json", "provider-cache/zona/301.json", "v2/other/301/1.json", "v2/film/../1.json"])
    assert.equal(expiredObject(name, now), false);
});

test("a film's newest card outlives the previous slot while it may still be carried forward", () => {
  const now = Date.parse("2026-09-12T05:00:00Z");
  const slot = objectSlot("film", "301", now);
  const film = (s) => `v2/film/301/${s}.json`;
  const staff = objectSlot("staff", "301", now);
  const names = [film(slot - 6), film(slot - 4), `v2/film/302/${objectSlot("film", "302", now) - 3}.json`, `v2/staff/301/${staff - 3}.json`];
  assert.deepEqual(deletableObjects(names, now), [film(slot - 6), `v2/staff/301/${staff - 3}.json`],
    "an older card of the same film and an old cast list go; each film's newest card stays");
  const tooOld = objectSlot("film", "301", now - RENEW_MS) - 2;
  assert.deepEqual(deletableObjects([film(tooOld)], now), [film(tooOld)], "past sixty days nothing is kept");
  assert.deepEqual(deletableObjects([film(slot - 1), film(slot)], now), [], "current and previous slots are never touched");
});
