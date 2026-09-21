import { readFile } from "node:fs/promises";
import vm from "node:vm";

// Loads the real app.js in a vm with a stub DOM: Proxy-based universal elements,
// quota-limited localStorage, location/history stubs and a fetch stub that
// serves the curated catalog chain. Shared by the watch-page meta tests and the
// playback fast-path tests.
const code = await readFile(new URL("../../app.js", import.meta.url), "utf8");

export const EMBED = "https://api.ortified.ws/embed/movie/88776";
export const ORT_KEY = `ort:${EMBED}`;
export const CATALOG = {
  schema: 1, revision: 243, forYou: "on",
  lists: [{ id: "l1", title: "Новинки", items: [{
    id: "x1", key: ORT_KEY, title: "Обсессия", year: "2025",
    poster: "https://static.cdnlbox.club/poster/web/2025/obsession.webp",
    description: "Безнадежный романтик Беар давно влюблён.",
    isSeries: false, movieLength: 109, rating: { kp: 7.251, imdb: 8.1 },
    target: { kind: "ort", embedUrl: EMBED },
  }] }],
};

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function makeSandbox({
  storageSeed = new Map(),
  catalog = CATALOG,
  quotaLimit = Infinity,
  startPath = "/",
  userAgent = "vm-test",
  hardwareConcurrency = 0,
} = {}) {
  const storage = new Map(storageSeed);
  let used = [...storage.entries()].reduce((n, [k, v]) => n + k.length + String(v).length, 0);
  const localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => {
      const value = String(v);
      const delta = k.length + value.length - (storage.has(k) ? k.length + storage.get(k).length : 0);
      if (used + delta > quotaLimit) { const e = new Error("QuotaExceededError"); e.name = "QuotaExceededError"; throw e; }
      used += delta; storage.set(k, value);
    },
    removeItem: (k) => { if (storage.has(k)) { used -= k.length + storage.get(k).length; storage.delete(k); } },
    key: (i) => [...storage.keys()][i] ?? null,
    get length() { return storage.size; },
  };

  const listeners = { window: {}, document: {} };
  function makeEl() {
    const store = { innerHTML: "", textContent: "", value: "", className: "", hidden: false };
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
          case "getBoundingClientRect": return () => ({ top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 });
          case "parentElement": case "parentNode": case "firstChild": case "nextSibling": return null;
          case "offsetWidth": case "offsetHeight": case "clientWidth": case "clientHeight": case "scrollLeft": case "scrollWidth": case "videoWidth": case "videoHeight": case "duration": case "currentTime": return 0;
          case "nodeType": return 1;
          case "tagName": return "DIV";
          case "getContext": return () => null;
          case "hasAttribute": case "contains": case "matches": return () => false;
          case "getAttribute": return () => null;
          case "play": case "load": return () => Promise.resolve();
          default: return () => {};
        }
      },
      set(_, prop, value) { store[prop] = value; return true; },
    });
  }

  const location = { pathname: startPath, search: "", hash: "", origin: "https://alphy.tv", host: "alphy.tv", hostname: "alphy.tv", href: `https://alphy.tv${startPath}`, protocol: "https:", assign: () => {}, replace: () => {}, reload: () => {} };
  const historyObj = {
    pushState: (_s, _t, url) => { if (typeof url === "string") { const u = new URL(url, "https://alphy.tv"); location.pathname = u.pathname; location.search = u.search; location.hash = u.hash; location.href = u.href; } },
    replaceState: (...a) => historyObj.pushState(...a),
    state: null, back: () => {}, length: 1,
  };

  const fetchStub = async (input) => {
    const url = String(input);
    const json = (body) => ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => body, text: async () => JSON.stringify(body) });
    if (url.includes("curated-config.json")) return json({ blobUrl: "/curated-live.json", fallbackUrl: "/curated-fallback.json" });
    if (url.includes("curated-live.json") || url.includes("curated-fallback.json")) return json(catalog);
    return { ok: false, status: 503, headers: { get: () => "" }, json: async () => ({}), text: async () => "" };
  };

  const documentObj = new Proxy({}, {
    get(_, prop) {
      switch (prop) {
        case "getElementById": case "createElement": return () => makeEl();
        case "createTextNode": return (t) => ({ nodeType: 3, textContent: t });
        case "addEventListener": return (type, fn) => { (listeners.document[type] ||= []).push(fn); };
        case "removeEventListener": return () => {};
        case "querySelector": return () => null;
        case "querySelectorAll": return () => [];
        case "body": case "documentElement": case "head": return makeEl();
        case "title": return "";
        case "visibilityState": return "visible";
        case "hidden": return false;
        case "fullscreenElement": return null;
        case "readyState": return "complete";
        default: return () => {};
      }
    },
    set: () => true,
  });

  const sandbox = {
    console, JSON, Math, Date, Promise, Number, String, Boolean, Array, Object, Set, Map, WeakMap, WeakSet, Symbol, Error, TypeError, RangeError, RegExp, parseInt, parseFloat, isFinite, isNaN, encodeURIComponent, decodeURIComponent, encodeURI, decodeURI, Infinity, NaN, undefined,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    URL, URLSearchParams, AbortController, TextDecoder, TextEncoder, Blob,
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000000", getRandomValues: (a) => a, subtle: { digest: async () => new ArrayBuffer(32) } },
    fetch: fetchStub,
    localStorage,
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    location, history: historyObj, document: documentObj,
    navigator: { userAgent, hardwareConcurrency, language: "ru", languages: ["ru"], clipboard: { writeText: async () => {} }, mediaSession: null },
    screen: { width: 1440, height: 900 },
    innerWidth: 1440, innerHeight: 900, devicePixelRatio: 2,
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {} }),
    requestAnimationFrame: (fn) => setTimeout(fn, 16), cancelAnimationFrame: (id) => clearTimeout(id),
    CustomEvent: class { constructor(type, opts) { this.type = type; this.detail = opts?.detail; } },
    Event: class { constructor(type) { this.type = type; } },
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    Image: class { set src(_) { setTimeout(() => this.onerror?.(), 1); } },
    XMLHttpRequest: class { open() {} send() { setTimeout(() => this.onerror?.(new Error("no net")), 1); } setRequestHeader() {} abort() {} },
    DOMParser: class { parseFromString() { return documentObj; } },
    postMessage: () => {},
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    scrollTo: () => {},
    alert: () => {}, confirm: () => false,
    performance: { now: () => Date.now() },
    structuredClone: (x) => JSON.parse(JSON.stringify(x)),
    Hls: undefined, shaka: undefined,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  sandbox.top = sandbox;
  sandbox.addEventListener = (type, fn) => { (listeners.window[type] ||= []).push(fn); };
  sandbox.removeEventListener = () => {};
  sandbox.dispatchEvent = () => true;
  vm.createContext(sandbox);
  return { sandbox, storage, listeners, run: () => vm.runInContext(code, sandbox) };
}
