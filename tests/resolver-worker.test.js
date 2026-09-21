import test from "node:test";
import assert from "node:assert/strict";

import worker from "../worker/src/index.js";

const env = { ALLOWED_ORIGIN: "http://127.0.0.1:5177" };

// These must reject before any upstream (mzona) call, so they stay fast and
// hermetic — no network, no 9s resolve wait.

test("rejects a non-numeric Zona kpId", async () => {
  const response = await worker.fetch(
    new Request("http://local/resolve-zona?kpId=abc"),
    env,
  );
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.ok, false);
  assert.equal(body.error, "missing_or_invalid_kpId");
});

test("rejects a missing Zona kpId", async () => {
  const response = await worker.fetch(
    new Request("http://local/resolve-zona"),
    env,
  );
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.ok, false);
  assert.equal(body.error, "missing_or_invalid_kpId");
});

test("recommendation API uses only managed recommendation keys and reports metrics", async () => {
  const originalFetch = globalThis.fetch;
  const attempts = [];
  const upstream = [];
  globalThis.fetch = async (request, init = {}) => {
    upstream.push({ url: String(request), key: init.headers?.["X-API-KEY"] });
    return new Response(JSON.stringify({ items: [{ filmId: 326, nameRu: "Побег" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const response = await worker.fetch(
      new Request("http://local/recommendations/similars?id=301"),
      {
        ALLOWED_ORIGIN: "http://127.0.0.1:5177",
        __KEY_POOL_MANAGED: true,
        __KEY_POOL_KEYS: [{
          id: "rec-1",
          provider: "unofficial",
          label: "recommendations",
          value: "secret-key",
          scopes: { resolver: false, recommendations: true },
        }],
        __recordKeyAttempt: (event) => attempts.push(event),
      },
    );
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.items[0].filmId, 326);
    assert.equal(upstream[0].key, "secret-key");
    assert.equal(attempts[0].id, "rec-1");
    assert.equal(attempts[0].operation, "recommendations:similars");
    assert.equal(attempts[0].ok, true);
    assert.equal(JSON.stringify(body).includes("secret-key"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("movie metadata keeps Kinopoisk person ids without extra upstream calls", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({
      id: 301,
      name: "Матрица",
      year: 1999,
      persons: [
        { id: 10, name: "Режиссёр", enProfession: "director" },
        { id: 20, name: "Актёр", enProfession: "actor" },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const response = await worker.fetch(new Request("http://local/movie?id=301"), {
      ALLOWED_ORIGIN: "http://127.0.0.1:5177",
      __KEY_POOL_MANAGED: true,
      __KEY_POOL_KEYS: [{
        id: "pk-1",
        provider: "poiskkino",
        label: "primary",
        value: "secret-key",
        scopes: { resolver: true, recommendations: false },
      }],
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(calls, 1);
    assert.deepEqual(body.movie.people.directors, [{ id: "10", name: "Режиссёр" }]);
    assert.deepEqual(body.movie.people.cast, [{ id: "20", name: "Актёр" }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("primaryOnly search never spends an Unofficial key on Deno", async () => {
  const originalFetch = globalThis.fetch;
  const hosts = [];
  globalThis.fetch = async (request) => {
    const url = new URL(String(request));
    hosts.push(url.hostname);
    if (url.hostname === "api.poiskkino.dev") {
      return new Response(JSON.stringify({ message: "daily quota" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ films: [{ filmId: 301, nameRu: "Матрица" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const response = await worker.fetch(
      new Request("http://local/search?q=matrix&primaryOnly=1"),
      {
        ALLOWED_ORIGIN: "http://127.0.0.1:5177",
        __KEY_POOL_MANAGED: true,
        __KEY_POOL_KEYS: [
          {
            id: "pk-private",
            provider: "poiskkino",
            value: "paid-key",
            scopes: { resolver: true, recommendations: false },
          },
          {
            id: "ku-fallback",
            provider: "unofficial",
            value: "free-key",
            scopes: { resolver: true, recommendations: true },
          },
        ],
      },
    );
    assert.equal(response.status, 500);
    assert.deepEqual(hosts, ["api.poiskkino.dev"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("batch recommendation metadata resolves a whole row with one PoiskKino request", async () => {
  const originalFetch = globalThis.fetch;
  const upstream = [];
  const attempts = [];
  globalThis.fetch = async (request, init = {}) => {
    upstream.push({ url: String(request), key: init.headers?.["X-API-KEY"] });
    return new Response(JSON.stringify({ docs: [
      { id: 301, name: "Матрица", year: 1999, rating: { kp: 8.5, imdb: 8.7 }, ageRating: null },
      { id: 309, name: "Эквилибриум", year: 2002, rating: { kp: 7.9, imdb: 7.3 }, ageRating: 16 },
    ] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const response = await worker.fetch(
      new Request("http://local/recommendations/meta?ids=301,309,301,bad"),
      {
        ALLOWED_ORIGIN: "http://127.0.0.1:5177",
        __KEY_POOL_MANAGED: true,
        __KEY_POOL_KEYS: [{
          id: "pk-batch",
          provider: "poiskkino",
          label: "batch",
          value: "secret-key",
          scopes: { resolver: true, recommendations: false },
        }],
        __recordKeyAttempt: (event) => attempts.push(event),
      },
    );
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(upstream.length, 1, "the row is one upstream request");
    const target = new URL(upstream[0].url);
    assert.deepEqual(target.searchParams.getAll("id"), ["301", "309"]);
    assert.equal(upstream[0].key, "secret-key");
    assert.equal(body.movies.length, 2);
    assert.equal(body.movies[0].ageRating, null, "missing age stays missing, not 0+");
    assert.deepEqual(body.movies[0].rating, { kp: 8.5, imdb: 8.7 });
    assert.equal(attempts[0].operation, "recommendations:batch-meta");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
