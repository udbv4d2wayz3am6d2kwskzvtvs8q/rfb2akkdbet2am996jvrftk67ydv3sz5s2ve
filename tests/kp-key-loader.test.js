import test from "node:test";
import assert from "node:assert/strict";
import { createKeyLoader } from "../supabase/functions/kp/key-pool.ts";

test("a cold broker can use the private snapshot while Vercel is down", async () => {
  const jobs = [];
  const known = [{ id: "k1", value: "test-key" }];
  const load = createKeyLoader({ rpc: async () => ({ revision: 3, keys: known, refresh: true }),
    loadManaged: async () => { throw new Error("control plane down"); }, background: (job) => jobs.push(job) });
  assert.deepEqual(await load(), known);
  await Promise.all(jobs);
  assert.deepEqual(await load(), known);
});

test("an empty newer registry removes keys and a delayed older refresh cannot restore them", async () => {
  let now = 1;
  const jobs = [];
  let stored = { revision: 3, keys: [{ id: "k1", value: "test-key" }], refresh: true };
  const load = createKeyLoader({ now: () => now, background: (job) => jobs.push(job),
    loadManaged: async () => ({ revision: 3, keys: [{ id: "k1", value: "test-key" }] }),
    rpc: async (name) => {
      if (name.endsWith("write")) stored = { revision: 4, keys: [], refresh: false };
      return stored;
    } });
  await load(); await Promise.all(jobs);
  assert.deepEqual(await load(), []);
  now += 6 * 60e3;
  assert.deepEqual(await load(), []);
});

test("a failed first load does not poison later attempts", async () => {
  let now = 1, available = false;
  const load = createKeyLoader({ now: () => now, background: () => {},
    rpc: async () => { if (!available) throw new Error("database unavailable"); return { revision: 3, keys: [], refresh: false }; },
    loadManaged: async () => { throw new Error("must not run"); } });
  await assert.rejects(load()); available = true; now += 31000;
  assert.deepEqual(await load(), []);
});
