import test from "node:test";
import assert from "node:assert/strict";

import { clientPool, normalizeKeyPool, runtimePool } from "../api/_key-pool-store.js";

test("key pool normalizes providers, scopes and duplicate secrets", () => {
  const pool = normalizeKeyPool({
    revision: 4,
    runtimeToken: "a".repeat(43),
    keys: [
      {
        id: "primary",
        provider: "poiskkino",
        label: "Primary",
        value: "pk-key",
        enabled: true,
        scopes: { resolver: true, recommendations: true },
      },
      {
        id: "duplicate",
        provider: "poiskkino",
        value: "pk-key",
        scopes: { resolver: true },
      },
      {
        id: "recs",
        provider: "unofficial",
        label: "Recommendations",
        value: "ku-key",
        enabled: true,
        scopes: { resolver: false, recommendations: true },
      },
      { provider: "unknown", value: "ignored" },
    ],
  });

  assert.equal(pool.revision, 4);
  assert.equal(pool.runtimeToken, "a".repeat(43));
  assert.equal(pool.keys.length, 2);
  assert.deepEqual(pool.keys[0].scopes, { resolver: true, recommendations: false, browser: false });
  assert.deepEqual(pool.keys[1].scopes, { resolver: false, recommendations: true, browser: true });
});

test("key pool preserves ids and creation time across admin updates", () => {
  const previous = normalizeKeyPool({
    runtimeToken: "b".repeat(43),
    keys: [{
      id: "stable",
      provider: "unofficial",
      value: "secret",
      label: "Old",
      scopes: { resolver: true },
      createdAt: "2026-01-01T00:00:00.000Z",
    }],
  });
  const next = normalizeKeyPool({
    keys: [{
      id: "stable",
      provider: "unofficial",
      value: "secret",
      label: "New",
      scopes: { recommendations: true },
    }],
  }, { nextRevision: 2, previous });

  assert.equal(next.revision, 2);
  assert.equal(next.runtimeToken, previous.runtimeToken);
  assert.equal(next.keys[0].id, "stable");
  assert.equal(next.keys[0].createdAt, "2026-01-01T00:00:00.000Z");
  assert.equal(next.keys[0].label, "New");
});

test("legacy client pool is empty and enabled keys move to the private runtime", () => {
  const pool = normalizeKeyPool({
    runtimeToken: "c".repeat(43),
    keys: [
      {
        id: "private-poisk",
        provider: "poiskkino",
        value: "paid-secret",
        scopes: { resolver: true, browser: true },
      },
      {
        id: "browser-free",
        provider: "unofficial",
        label: "Free browser key",
        value: "free-secret",
        scopes: { browser: true },
      },
      {
        id: "disabled-free",
        provider: "unofficial",
        value: "disabled-secret",
        enabled: false,
        scopes: { browser: true },
      },
    ],
  });

  assert.deepEqual(clientPool(pool).keys, []);
  assert.equal(JSON.stringify(clientPool(pool)).includes("paid-secret"), false);
  // Previously browser-scoped keys are now spent only by the private broker.
  assert.equal(runtimePool(pool).keys.some((key) => key.id === "browser-free"), true);
  assert.equal(runtimePool(pool).keys.some((key) => key.id === "disabled-free"), false);
});
