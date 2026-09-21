// Identity resolution: anything we can show -> an IMDb id.
//
// This exists because the IMDb id used to be reachable only through PoiskKino,
// which is metered. One spent daily quota took down search, the IMDb badge and
// the Letterboxd score at once, even though two of those three only ever needed
// an id — a fact that never changes and costs nothing to remember.
//
// So identity is now its own layer, and it is deliberately free of anything
// metered. In order of cost:
//
//   1. the id the payload already carries        (Kinopoisk search results)
//   2. imdb-map.json, built at build time        (the curated catalogue)
//   3. localStorage, hits and misses alike       (anything seen before)
//   4. Cinemeta                                  (free, unmetered, CORS-open)
//
// Nothing here ever calls PoiskKino. A dead quota must degrade search alone.
(function () {
  "use strict";

  const MAP_URL = window.__alphyAssetUrl?.("imdb-map.json") || "/imdb-map.json";
  const CINEMETA = "https://v3-cinemeta.strem.io/catalog";
  const STORE_PREFIX = "alphy.imdbid.v2:";
  // An id is a permanent fact, so it is kept for a season. A miss is kept far
  // more briefly: it usually means Cinemeta has no such title, but it can also
  // mean the network was having a bad minute.
  const TTL_HIT = 90 * 24 * 3600e3;
  const TTL_MISS = 3 * 24 * 3600e3;
  const TIMEOUT_MS = 9000;
  // A search grid can hold thirty cards with no id between them. Cinemeta is
  // unmetered but that is no reason to open thirty sockets at once.
  const CONCURRENCY = 4;

  const IMDB_RE = /^tt\d{6,10}$/;

  const normalizeTitle = (value) => String(value || "")
    .toLowerCase().replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/gi, " ").trim();

  const mapKey = (title, year, isSeries = false) =>
    `${normalizeTitle(title)}|${String(year || "").slice(0, 4)}|${isSeries ? "s" : "f"}`;

  const yearOf = (value) => {
    const year = Number(String(value ?? "").slice(0, 4));
    return Number.isFinite(year) && year > 1880 && year < 2200 ? year : null;
  };

  const releaseYear = (meta) => yearOf(meta?.year ?? meta?.releaseInfo);

  // ---------------------------------------------------------------- storage

  function cacheGet(key) {
    try {
      const raw = localStorage.getItem(STORE_PREFIX + key);
      if (!raw) return undefined;
      const entry = JSON.parse(raw);
      if (!entry || Date.now() > entry.e) {
        localStorage.removeItem(STORE_PREFIX + key);
        return undefined;
      }
      return entry.v;
    } catch {
      return undefined;
    }
  }

  function cacheSet(key, value) {
    const ttl = value ? TTL_HIT : TTL_MISS;
    try {
      localStorage.setItem(STORE_PREFIX + key, JSON.stringify({ v: value, e: Date.now() + ttl }));
    } catch {
      // Out of room: drop our own oldest entries rather than let a full quota
      // turn into a permanently cold cache.
      try {
        const mine = Object.keys(localStorage).filter((k) => k.startsWith(STORE_PREFIX));
        for (const k of mine.slice(0, Math.ceil(mine.length / 4))) localStorage.removeItem(k);
        localStorage.setItem(STORE_PREFIX + key, JSON.stringify({ v: value, e: Date.now() + ttl }));
      } catch { /* nothing more to do; resolution still works, just uncached */ }
    }
  }

  // ------------------------------------------------------------- static map

  let mapPromise = null;
  let staticMap = null;

  function loadStaticMap() {
    if (staticMap) return Promise.resolve(staticMap);
    if (!mapPromise) {
      mapPromise = fetch(MAP_URL, { cache: "force-cache" })
        .then((response) => (response.ok ? response.json() : null))
        .then((payload) => { staticMap = payload?.entries || {}; return staticMap; })
        .catch(() => { staticMap = {}; return staticMap; });
    }
    return mapPromise;
  }

  // --------------------------------------------------------------- cinemeta

  async function cinemetaSearch(type, query) {
    const url = `${CINEMETA}/${type}/top/search=${encodeURIComponent(query)}.json`;
    const response = await fetch(url, {
      cache: "force-cache",
      credentials: "omit",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Cinemeta ${response.status}`);
    return (await response.json())?.metas ?? [];
  }

  // The year is the entire safety net. Cinemeta ranks by popularity, so a short
  // or common title ("Драйв", "Маяк") would otherwise bind to whatever happens
  // to be famous this year and quietly show the wrong film's score. Without a
  // year we would rather return nothing.
  function pickCandidate(metas, wantedYear) {
    if (!Number.isFinite(wantedYear)) return "";
    for (const meta of metas) {
      const id = String(meta?.imdb_id || "");
      const year = releaseYear(meta);
      if (IMDB_RE.test(id) && year !== null && Math.abs(year - wantedYear) <= 1) return id;
    }
    return "";
  }

  // ---------------------------------------------------------------- queue

  const inflight = new Map();
  let active = 0;
  const pending = [];

  function schedule(task) {
    return new Promise((resolve) => {
      pending.push(async () => {
        active += 1;
        try { resolve(await task()); } catch { resolve(""); } finally {
          active -= 1;
          drain();
        }
      });
      drain();
    });
  }

  function drain() {
    while (active < CONCURRENCY && pending.length) pending.shift()();
  }

  // ---------------------------------------------------------------- resolve

  /**
   * @param {{title?:string, originalTitle?:string, year?:string|number,
   *          isSeries?:boolean, imdb?:string, imdbId?:string,
   *          externalId?:{imdb?:string}, externalIds?:{imdb?:string}}} item
   * @returns {Promise<string>} an IMDb id, or "" when it cannot be known
   */
  async function resolve(item) {
    const carried = String(
      item?.imdb || item?.imdbId || item?.externalId?.imdb || item?.externalIds?.imdb || "",
    ).toLowerCase();
    if (IMDB_RE.test(carried)) return carried;

    const title = String(item?.title || "").trim();
    const year = yearOf(item?.year);
    if (!title || year === null) return "";

    const key = mapKey(title, year, !!item?.isSeries);

    const map = await loadStaticMap();
    const baked = map[key]?.imdb;
    if (IMDB_RE.test(String(baked || ""))) return baked;

    const cached = cacheGet(key);
    if (cached !== undefined) return cached || "";

    if (inflight.has(key)) return inflight.get(key);

    // Cinemeta indexes English titles but carries the same alias table Stremio
    // ships, so a Russian title resolves. An original title, when a source gives
    // one, is still the better query — it is what Cinemeta actually stores.
    const query = String(item?.originalTitle || "").trim() || title;
    const type = item?.isSeries ? "series" : "movie";

    const run = schedule(async () => {
      let found = "";
      try {
        found = pickCandidate(await cinemetaSearch(type, query), year);
        // A source's original title can be a transliteration Cinemeta does not
        // know; the Russian title goes through its alias table and often does.
        if (!found && query !== title) {
          found = pickCandidate(await cinemetaSearch(type, title), year);
        }
      } catch {
        // Reachability is not a verdict about the film, so it is not cached.
        inflight.delete(key);
        return "";
      }
      cacheSet(key, found);
      inflight.delete(key);
      return found;
    });

    inflight.set(key, run);
    return run;
  }

  /**
   * Resolves a list, returning only what could be resolved. Order is not
   * preserved and unresolvable entries are simply absent.
   * @returns {Promise<Map<object, string>>}
   */
  async function resolveMany(items) {
    const list = Array.isArray(items) ? items : [];
    const found = new Map();
    await Promise.all(list.map(async (item) => {
      const id = await resolve(item);
      if (id) found.set(item, id);
    }));
    return found;
  }

  window.alphyIdentity = {
    resolve,
    resolveMany,
    _test: { normalizeTitle, mapKey, pickCandidate, releaseYear },
  };
})();
