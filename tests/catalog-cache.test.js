import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(__dirname, "..", "catalog-cache.js"), "utf8");

function makeResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function catalog(revision, title = `r${revision}`) {
  return { schema: 1, revision, updatedAt: null, lists: [{ id: "x", title, items: [] }] };
}

async function flush(ms = 15) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function harness({
  cached = null,
  primary = catalog(5),
  fallback = catalog(4),
  blob = catalog(6),
  primaryStatus = 200,
  fallbackStatus = 200,
  admin = false,
  dirty = false,
} = {}) {
  const store = new Map();
  if (cached) {
    store.set("alphy.curated.public.v3", JSON.stringify({
      revision: cached.revision,
      savedAt: 1,
      catalog: cached,
    }));
  }
  const calls = [];

  const nativeFetch = async (input) => {
    const url = new URL(String(input), "https://alphy.tv/");
    calls.push(url.href);
    if (url.hostname === "cdn.jsdelivr.net") return makeResponse(primary, primaryStatus);
    if (url.pathname === "/curated-fallback.json") return makeResponse(fallback, fallbackStatus);
    if (url.href.includes("/catalog/current.json")) {
      return makeResponse({ blobUrl: "https://store.public.blob.vercel-storage.com/catalog/r6.json" });
    }
    if (url.hostname.endsWith(".public.blob.vercel-storage.com") && url.pathname.endsWith("/catalog/r6.json")) {
      return makeResponse(blob);
    }
    if (url.pathname === "/api/admin/catalog") return makeResponse({ ok: true, catalog: blob });
    if (url.pathname === "/curated-live.json") return makeResponse(fallback);
    throw new Error(`unexpected fetch ${url.href}`);
  };

  const localStorage = {
    getItem(key) { return store.has(key) ? store.get(key) : null; },
    setItem(key, value) { store.set(key, String(value)); },
    removeItem(key) { store.delete(key); },
  };

  const events = [];
  const window = {
    fetch: nativeFetch,
    localStorage,
    location: { href: "https://alphy.tv/", origin: "https://alphy.tv" },
    requestIdleCallback(callback) { setTimeout(callback, 0); },
    dispatchEvent(event) { events.push(event); },
  };
  window.window = window;

  const context = vm.createContext({
    window,
    localStorage,
    location: window.location,
    URL,
    Request,
    Response,
    CustomEvent: class CustomEvent {
      constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
    },
    setTimeout,
    clearTimeout,
    Date,
    JSON,
    Number,
    String,
    Array,
    Error,
    Promise,
    console,
    requestIdleCallback: window.requestIdleCallback,
  });
  vm.runInContext(source, context, { filename: "catalog-cache.js" });

  let renders = 0;
  function mount(initial) {
    window.alphyCatalog = {
      isAdmin: () => admin,
      render() { renders += 1; },
      _test: { state: { catalog: initial, admin, dirty } },
    };
  }

  return {
    window,
    calls,
    store,
    events,
    mount,
    get renders() { return renders; },
  };
}

test("warm public open returns local cache without Vercel catalog traffic", async () => {
  const h = harness({ cached: catalog(5), primary: catalog(5) });
  h.mount(catalog(5));
  const result = await (await h.window.fetch("/curated-live.json")).json();
  assert.equal(result.revision, 5);
  assert.equal(h.calls.some((url) => url.includes("alphy.tv/curated-fallback.json")), false);
  assert.equal(h.calls.some((url) => url.includes("vercel-storage.com")), false);
  await flush(20);
});

test("cold open gets catalog from jsDelivr", async () => {
  const h = harness({ primary: catalog(5), fallback: catalog(4) });
  h.mount(catalog(5));
  const result = await (await h.window.fetch("/curated-live.json")).json();
  assert.equal(result.revision, 5);
  assert.ok(h.calls.some((url) => url.includes("cdn.jsdelivr.net/gh/udbv4d2wayz3am6d2kwskzvtvs8q/rfb2akkdbet2am996jvrftk67ydv3sz5s2ve@catalog-cdn/curated-fallback.json")));
  assert.equal(h.calls.some((url) => url.includes("alphy.tv/curated-fallback.json")), false);
  assert.equal(h.calls.some((url) => url.includes("vercel-storage.com")), false);
});

test("newer jsDelivr snapshot hot-applies over warm cache", async () => {
  const h = harness({ cached: catalog(4), primary: catalog(5) });
  h.mount(catalog(4));
  h.store.set("alphy.curated.public-refresh.v2", "0");
  await h.window.fetch("/curated-live.json");
  await flush(40);
  assert.equal(h.window.alphyCatalog._test.state.catalog.revision, 5);
  assert.ok(h.renders >= 1);
});

test("Vercel static is used only when jsDelivr fails", async () => {
  const h = harness({ primaryStatus: 503, fallback: catalog(4), blob: catalog(6) });
  h.mount(catalog(4));
  const result = await (await h.window.fetch("/curated-live.json")).json();
  assert.equal(result.revision, 4);
  assert.ok(h.calls.some((url) => url.includes("cdn.jsdelivr.net")));
  assert.ok(h.calls.some((url) => url.includes("alphy.tv/curated-fallback.json")));
  assert.equal(h.calls.some((url) => url.includes("vercel-storage.com")), false);
});

test("a total CDN failure uses the catalog endpoint without Vercel Blob", async () => {
  const h = harness({ primaryStatus: 503, fallbackStatus: 503, blob: catalog(6) });
  h.mount(catalog(6));
  const result = await (await h.window.fetch("/curated-live.json")).json();
  assert.equal(result.revision, 4);
  assert.ok(h.calls.some((url) => url.endsWith("/curated-live.json")));
  assert.ok(h.calls.every((url) => !url.includes("vercel-storage.com")));
});

test("background refresh never overwrites an admin draft", async () => {
  const h = harness({ cached: catalog(4), primary: catalog(5), admin: true, dirty: true });
  h.mount(catalog(4));
  h.store.set("alphy.curated.public-refresh.v2", "0");
  await h.window.fetch("/curated-live.json");
  await flush(40);
  assert.equal(h.window.alphyCatalog._test.state.catalog.revision, 4);
  assert.equal(h.renders, 0);
  const saved = JSON.parse(h.store.get("alphy.curated.public.v3"));
  assert.equal(saved.catalog.revision, 5);
});

test("successful admin catalog response primes the public cache", async () => {
  const h = harness({ cached: catalog(4), blob: catalog(6), admin: true });
  const response = await h.window.fetch("/api/admin/catalog", { method: "PUT" });
  assert.equal(response.status, 200);
  await flush(10);
  const saved = JSON.parse(h.store.get("alphy.curated.public.v3"));
  assert.equal(saved.catalog.revision, 6);
});
