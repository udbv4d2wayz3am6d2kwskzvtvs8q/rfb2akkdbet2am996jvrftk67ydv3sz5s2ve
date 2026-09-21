import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// Loads the real catalog.js in a vm with a stub DOM and verifies findReady —
// the title+year+type index that lets search and «Для вас» open already-curated
// (resolved) targets instead of re-running the kp resolve flow.
const code = await readFile(new URL("../catalog.js", import.meta.url), "utf8");

const CATALOG = {
  schema: 1, revision: 250, forYou: "on",
  lists: [{ id: "l1", title: "Новинки", items: [
    {
      id: "x1", key: "ort:https://api.ortified.ws/embed/movie/88776",
      title: "Обсессия", year: "2025", isSeries: false,
      poster: "https://static.cdnlbox.club/poster/web/2025/obsession.webp",
      rating: { kp: 7.2 },
      externalId: { imdb: "tt3398228", tmdb: "12345" },
      target: { kind: "ort", embedUrl: "https://api.ortified.ws/embed/movie/88776" },
    },
    {
      id: "x2", key: "kp:12345",
      title: "Кино через резолв", year: "2024", isSeries: false,
      target: { kind: "kp", kpId: "12345" },
    },
  ] }],
};

function makeEl() {
  const store = { innerHTML: "", textContent: "", value: "", className: "" };
  const classes = new Set();
  return new Proxy({}, {
    get(_, prop) {
      if (prop in store) return store[prop];
      switch (prop) {
        case "classList": return { add: (...c) => c.forEach((x) => classes.add(x)), remove: (...c) => c.forEach((x) => classes.delete(x)), toggle: (c, f) => (f ? classes.add(c) : classes.delete(c)), contains: (c) => classes.has(c) };
        case "style": return new Proxy({}, { get: () => () => {}, set: () => true });
        case "dataset": return {};
        case "children": case "childNodes": return [];
        case "querySelectorAll": return () => [];
        case "querySelector": case "closest": return () => null;
        case "appendChild": case "insertBefore": return (x) => x;
        case "getBoundingClientRect": return () => ({ top: 0, left: 0, width: 0, height: 0 });
        case "parentElement": case "parentNode": return null;
        case "offsetWidth": case "offsetHeight": case "clientWidth": case "scrollWidth": case "scrollLeft": return 0;
        case "getAttribute": return () => null;
        case "hasAttribute": case "matches": case "contains": return () => false;
        default: return () => {};
      }
    },
    set() { return true; },
  });
}

async function loadCatalog() {
  const storage = new Map();
  const fetchStub = async (input) => {
    const url = String(input);
    const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
    if (url.includes("curated-config.json")) return json({ blobUrl: "/curated-live.json", fallbackUrl: "/curated-fallback.json" });
    if (url.includes("curated-live.json") || url.includes("curated-fallback.json")) return json(CATALOG);
    return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
  };
  const documentObj = new Proxy({}, {
    get(_, prop) {
      switch (prop) {
        case "getElementById": case "createElement": return () => makeEl();
        case "createTextNode": return (t) => ({ textContent: t });
        case "addEventListener": case "removeEventListener": return () => {};
        case "querySelector": return () => null;
        case "querySelectorAll": return () => [];
        case "body": case "documentElement": return makeEl();
        default: return () => {};
      }
    },
    set: () => true,
  });
  const sandbox = {
    console, JSON, Math, Date, Promise, Number, String, Array, Object, Set, Map, RegExp, parseInt, parseFloat, isFinite, isNaN, encodeURIComponent, decodeURIComponent,
    setTimeout, clearTimeout, queueMicrotask,
    URL, URLSearchParams,
    crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000000" },
    fetch: fetchStub,
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
      key: (i) => [...storage.keys()][i] ?? null,
      get length() { return storage.size; },
    },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    document: documentObj,
    location: { pathname: "/", search: "", hash: "", origin: "https://alphy.tv" },
    navigator: { language: "ru" },
    CustomEvent: class { constructor(type, opts) { this.type = type; this.detail = opts?.detail; } },
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: (fn) => setTimeout(fn, 16),
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    performance: { now: () => Date.now() },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.addEventListener = () => {};
  sandbox.removeEventListener = () => {};
  sandbox.dispatchEvent = () => true;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  // init() is async (fetches the catalog) — let it settle.
  await new Promise((resolve) => setTimeout(resolve, 100));
  return sandbox;
}

test("findReady matches curated titles by normalized title + year + type", async () => {
  const sandbox = await loadCatalog();
  const find = sandbox.window.alphyCatalog.findReady;
  assert.equal(find("Обсессия", "2025", false)?.target?.kind, "ort", "exact match returns the resolved item");
  assert.equal(find("  обсессия!!! ", 2025, false)?.target?.kind, "ort", "normalization tolerates case/punctuation");
  assert.equal(find("Обсессия", "2025", true), null, "series/movie type must agree");
  assert.equal(find("Обсессия", "2024", false), null, "year must match exactly");
  assert.equal(find("Обсессия", "", false), null, "no year — no match");
  assert.equal(find("Кино через резолв", "2024", false), null, "kp-target items are not shortcuts");
  assert.equal(
    sandbox.window.alphyCatalog.getCatalog().bookmarkBannerText,
    "Добавьте сайт в закладки",
    "older catalog snapshots receive the editable banner text default",
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(sandbox.window.alphyCatalog.getCatalog().lists[0].items[0].externalId)),
    { imdb: "tt3398228", tmdb: "12345" },
    "stable external identity must survive the browser catalog normalizer",
  );
});

test("an admin metadata refresh persists IMDb identity into the catalog item", async () => {
  const sandbox = await loadCatalog();
  const item = { title: "Обсессия", rating: {} };
  sandbox.window.alphyCatalog._test.applyItemMetadata(item, {
    kpId: "123",
    imdbId: "tt3398228",
    externalId: { tmdb: "456" },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(item.externalId)), { imdb: "tt3398228", tmdb: "456" });
});
