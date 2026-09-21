(() => {
  "use strict";

  // =====================================================================
  // «Для вас» — personalized ranking and storage stay client-side.
  //
  // Candidate lists come from Kinopoisk Unofficial through shared objects.
  // Only cache misses reach the server. Seeds, blending, scoring and filtering
  // keep the existing client-side behavior; API keys remain server-side.
  //
  // Modes (admin-controlled via the curated catalog envelope, see catalog.js):
  //   on     — full pipeline, budgeted network fetches allowed
  //   frozen — render from localStorage caches only, zero network
  //   off    — feature disabled for everyone, no computation at all
  // =====================================================================

  const SIM_PREFIX = "alphy.foryou.sim.";
  const META_PREFIX = "alphy.foryou.meta.";
  const LOOKUP_PREFIX = "alphy.foryou.lookup.";
  const QUOTA_PREFIX = "alphy.foryou.quota.";
  const LAST_KEY = "alphy.foryou.last.v1";
  const HIDDEN_KEY = "alphy.foryou.hidden.v1";
  const HIDDEN_CAP = 400;
  // Public immutable objects are the hot path. The private broker is reached
  // only through the resolver, which coalesces simultaneous misses.
  const KP_OBJECT_HOSTS = ["xoathqkggcuyoyutxwri", "hcuhanruaclhiltpdegc", "matozzgmaranfemgxpzy"];
  const KP_GROUP_HOSTS = Array.from({ length: 256 }, (_, group) => group % 3);
  const UNOFFICIAL_BASE_URL = "https://kinopoiskapiunofficial.tech";

  const SIM_TTL = 30 * 24 * 3600e3;
  const META_TTL = 30 * 24 * 3600e3;
  const LOOKUP_TTL = 30 * 24 * 3600e3;
  const NEGATIVE_TTL = 6 * 3600e3;

  const MAX_SEEDS = 8;
  const MAX_SIM_FETCH_PER_RUN = 6;
  const MAX_META_BATCH_SIZE = 18;
  const MAX_LOOKUP_PER_RUN = 3;
  // The pool is ~500 calls/day per key of real capacity. The cap is the safety
  // rail, not the target: the pipeline is cache-first, so a normal day spends a
  // handful. It now also covers «Похожее» (≤1 call per newly opened title) and
  // watch-page credits backfill, which is exactly why it is no longer 60 — a few
  // evenings of browsing new titles must not silently switch the row off.
  const DAILY_FETCH_CAP = 220;
  const FETCH_CONCURRENCY = 3;
  const ROW_SIZE = 18;
  const MIN_ROW = 3;
  const MAX_PER_SEED = 7;
  const RECOMPUTE_MIN_MS = 60e3;

  // «Похожее» (under the player)
  const SIMILAR_ROW_SIZE = 14;
  const SIMILAR_MIN_ROW = 4;
  // How hard the viewer's taste is allowed to re-order the title's own similars.
  // The row must stay recognisably about the title being watched, so affinity
  // re-ranks within that list instead of replacing it.
  const SIMILAR_TASTE_WEIGHT = 1.1;

  const state = {
    mode: null,          // null until catalog.js delivers the envelope flag
    items: [],
    computing: false,
    queued: false,
    lastFingerprint: "",
    lastComputeAt: 0,
  };

  function log(...args) {
    try {
      if (localStorage.getItem("alphy.debug")) console.log("[foryou]", ...args);
    } catch { /* ignore */ }
  }

  // `mode` arrives from catalog.js once the curated envelope is loaded. The watch
  // page can ask for recommendations before that lands (deep link straight into a
  // player), so callers wait briefly instead of silently getting an empty row.
  // Timing out means the catalog is unreachable — stay off rather than guess.
  let resolveModeReady;
  const modeReady = new Promise((resolve) => { resolveModeReady = resolve; });

  function whenModeReady(timeoutMs = 4000) {
    if (state.mode) return Promise.resolve(state.mode);
    return Promise.race([
      modeReady,
      new Promise((resolve) => setTimeout(() => resolve(state.mode), timeoutMs)),
    ]);
  }

  // --- localStorage helpers (own namespaces, TTL envelopes like app.js) ---

  function lsGet(key) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed?.exp && Date.now() > parsed.exp) {
        localStorage.removeItem(key);
        return null;
      }
      return parsed?.v ?? null;
    } catch {
      return null;
    }
  }

  function lsSet(key, value, ttlMs) {
    const payload = JSON.stringify({ v: value, exp: ttlMs ? Date.now() + ttlMs : 0 });
    try {
      localStorage.setItem(key, payload);
    } catch {
      evictOwnCaches();
      try { localStorage.setItem(key, payload); } catch { /* give up */ }
    }
  }

  // On quota pressure drop our own cache entries, oldest expiry first — never
  // touch the app's history/bookmarks/meta storage.
  function evictOwnCaches() {
    const own = [];
    try {
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i) || "";
        if (key.startsWith(SIM_PREFIX) || key.startsWith(META_PREFIX) || key.startsWith(LOOKUP_PREFIX)) {
          let exp = 0;
          try { exp = JSON.parse(localStorage.getItem(key) || "{}").exp || 0; } catch { /* oldest */ }
          own.push({ key, exp });
        }
      }
      own.sort((a, b) => a.exp - b.exp);
      own.slice(0, Math.max(8, Math.ceil(own.length / 3))).forEach((entry) => {
        localStorage.removeItem(entry.key);
      });
    } catch { /* ignore */ }
  }

  function loadStore(key) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || "[]");
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  }

  // --- dismissed recommendations -----------------------------------------
  // A hidden title is only removed from the row and never suggested again.
  // It is NOT a negative taste signal: hiding one gross body horror must not
  // stop the engine from recommending body horror — the seeds stay untouched.

  function hiddenIds() {
    return new Set(loadStore(HIDDEN_KEY).map((entry) => String(entry?.id ?? entry)));
  }

  function hide(kpId) {
    const id = String(kpId || "");
    if (!/^\d+$/.test(id)) return;
    const list = loadStore(HIDDEN_KEY);
    if (!list.some((entry) => String(entry?.id ?? entry) === id)) list.push({ id, at: Date.now() });
    try { localStorage.setItem(HIDDEN_KEY, JSON.stringify(list.slice(-HIDDEN_CAP))); } catch { /* ignore */ }
    state.items = state.items.filter((item) => String(item?.target?.kpId || "") !== id);
    try { localStorage.setItem(LAST_KEY, JSON.stringify({ items: state.items, at: Date.now() })); } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent("alphy:foryou"));
    // Backfill the freed slot: similars are cached, so this is (near) zero-network.
    compute();
  }

  // --- daily fetch budget ------------------------------------------------

  function quotaKey() {
    return `${QUOTA_PREFIX}${new Date().toISOString().slice(0, 10)}`;
  }

  function fetchesToday() {
    try { return Number(localStorage.getItem(quotaKey())) || 0; } catch { return 0; }
  }

  function countFetch() {
    try {
      const key = quotaKey();
      localStorage.setItem(key, String(fetchesToday() + 1));
      // Opportunistically drop yesterday's counters.
      for (let i = localStorage.length - 1; i >= 0; i -= 1) {
        const other = localStorage.key(i) || "";
        if (other.startsWith(QUOTA_PREFIX) && other !== key) localStorage.removeItem(other);
      }
    } catch { /* ignore */ }
  }

  function budgetLeft() {
    return DAILY_FETCH_CAP - fetchesToday();
  }

  // --- Shared API access -------------------------------------------------
  try { localStorage.removeItem("alphy.foryou.clientPool.v1"); } catch { /* optional */ }

  function kpPlacementGroup(id) {
    let hash = 0;
    for (const char of String(id)) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
    return hash % 256;
  }

  const KP_OBJECT_TTLS = { film: 7 * 86400e3, staff: 30 * 86400e3, similars: 30 * 86400e3, search: 6 * 3600e3 };
  function kpObjectUrl(kind, id, { replica = false, previous = false } = {}) {
    const group = kpPlacementGroup(id);
    const host = KP_OBJECT_HOSTS[(KP_GROUP_HOSTS[group] + (replica ? 1 : 0)) % 3];
    const slot = Math.floor(Date.now() / KP_OBJECT_TTLS[kind] + group / 256) - (previous ? 1 : 0);
    return `https://${host}.supabase.co/storage/v1/object/public/kp/v2/${kind}/${id}/${slot}.json`;
  }

  function sharedTarget(path) {
    const url = new URL(path, UNOFFICIAL_BASE_URL);
    let match = url.pathname.match(/^\/api\/v2\.2\/films\/(\d+)$/);
    if (match) return { kind: "film", id: match[1] };
    match = url.pathname.match(/^\/api\/v2\.2\/films\/(\d+)\/similars$/);
    if (match) return { kind: "similars", id: match[1] };
    if (url.pathname === "/api/v2.1/films/search-by-keyword") return { kind: "search", q: url.searchParams.get("keyword") || "" };
    const filmId = url.searchParams.get("filmId") || "";
    if (url.pathname === "/api/v1/staff" && /^\d+$/.test(filmId)) return { kind: "staff", id: filmId };
    return null;
  }

  // A film the provider does not know is reported exactly as the provider
  // would have reported it, so every caller's existing 404 handling applies.
  function unwrapShared(object) {
    if (object?.status === "missing") {
      const error = new Error("Unofficial 404");
      error.status = 404;
      throw error;
    }
    // Keep the shared expiry through the browser API without changing the
    // provider's serialised fields. A near-expired search must not gain six
    // more hours when the page puts it into localStorage.
    if (object.data && typeof object.data === "object") {
      Object.defineProperty(object.data, "__alphyFreshUntil", {
        value: Date.parse(object.freshUntil), enumerable: false, configurable: true,
      });
    }
    return object.data;
  }

  async function sharedJson(url, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const object = await response.json();
      return object?.v === 1 ? object : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  // Resolves to the provider's payload, or undefined when the shared cache
  // could not answer — then the caller carries on exactly as before.
  const sharedInflight = new Map();
  const sharedCooldown = new Map();
  // `card`: the caller paints a card in a row — «Похожее», search results — and
  // is content with last week's copy. Only a film's own page asks for a fresher
  // one, so a row of eighteen does not send eighteen films back to the provider.
  async function sharedUnofficialGet(path, { card = false } = {}) {
    const target = sharedTarget(path);
    if (!target) return undefined;
    const key = JSON.stringify(target) + (card ? "|card" : "");
    if (sharedInflight.has(key)) return sharedInflight.get(key);
    const pending = (async () => {
      if (target.kind === "search" && globalThis.crypto?.subtle && typeof TextEncoder !== "undefined") {
        const q = target.q.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(q));
        target.id = String(parseInt([...new Uint8Array(digest)].slice(0, 6).map((b) => b.toString(16).padStart(2, "0")).join(""), 16) + 1);
      }
      const matches = (v) => v?.v === 1 && v.kind === target.kind && (target.kind === "search"
        ? v.query === target.q.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim()
        : String(v.id) === target.id);
      let stored = null;
      if (target.id) {
        for (const replica of [false, true]) {
          const value = await sharedJson(kpObjectUrl(target.kind, target.id, { replica }), 2500);
          if (matches(value)) stored = value;
          if (matches(value) && Date.parse(value.freshUntil) > Date.now()) return unwrapShared(value);
        }
      }
      if (card && !stored && target.id) {
        for (const replica of [false, true]) {
          const value = await sharedJson(kpObjectUrl(target.kind, target.id, { replica, previous: true }), 2000);
          if (matches(value) && value.status === "ok") return unwrapShared(value);
        }
      }
      if (budgetLeft() > 0 && (sharedCooldown.get(key) || 0) <= Date.now()) {
        const request = window.alphyBridge?.resolverJson;
        try {
          if (typeof request !== "function") throw new Error("resolver unavailable");
          countFetch();
          const value = await request(`/kp?${new URLSearchParams(target)}`, { retries: 0, timeoutMs: 15000 });
          if (matches(value)) return unwrapShared(value);
        } catch (error) {
          if (error.status === 404) throw error;
        }
        sharedCooldown.set(key, Date.now() + 60000);
        if (sharedCooldown.size > 256) sharedCooldown.delete(sharedCooldown.keys().next().value);
      }
      if (!stored && target.id) {
        for (const replica of [false, true]) {
          const value = await sharedJson(kpObjectUrl(target.kind, target.id, { replica, previous: true }), 2000);
          if (matches(value)) { stored = value; break; }
        }
      }
      return stored ? unwrapShared(stored) : undefined;
    })().finally(() => sharedInflight.delete(key));
    sharedInflight.set(key, pending);
    return pending;
  }

  function directUnofficialUrl(path) {
    const url = new URL(path, UNOFFICIAL_BASE_URL);
    if (url.origin !== UNOFFICIAL_BASE_URL) return "";
    const allowed = [
      /^\/api\/v2\.1\/films\/search-by-keyword$/,
      /^\/api\/v2\.2\/films\/\d+$/,
      /^\/api\/v2\.2\/films\/\d+\/similars$/,
      /^\/api\/v1\/staff$/,
    ];
    return allowed.some((pattern) => pattern.test(url.pathname)) ? url.href : "";
  }

  function budgetError() {
    const error = new Error("foryou daily budget exhausted");
    error.code = "budget";
    return error;
  }

  // Kept under its exported name for callers; keys never leave the server.
  async function directUnofficialGet(path, options = {}) {
    if (!directUnofficialUrl(path)) throw new Error("unsupported unofficial path");
    const shared = await sharedUnofficialGet(path, options);
    if (shared !== undefined) return shared;
    if (budgetLeft() <= 0) throw budgetError();
    const error = new Error("shared metadata temporarily unavailable");
    error.code = "shared_unavailable";
    throw error;
  }

  async function apiGet(path) {
    return directUnofficialGet(path);
  }

  // --- seeds ---------------------------------------------------------------

  function normTitle(value) {
    return String(value || "")
      .toLocaleLowerCase("ru-RU")
      .replace(/[ёе]/g, "е")
      .replace(/[^a-zа-я0-9]+/gi, " ")
      .trim();
  }

  function recencyWeight(timestamp, halfLifeDays) {
    if (!timestamp) return 0.3;
    const ageDays = Math.max(0, (Date.now() - timestamp) / 86400e3);
    return Math.max(0.15, Math.pow(0.5, ageDays / halfLifeDays));
  }

  function engagementWeight(entry) {
    const progress = Number(entry.progress) || 0;
    if (progress >= 0.85) return 1;
    if (progress >= 0.4) return 0.85;
    if (progress >= 0.15) return 0.7;
    if (progress >= 0.05 || Number(entry.position) >= 300) return 0.55;
    if (progress >= 0.005 || Number(entry.position) >= 30) return 0.2;
    // recordOpen writes history before playback begins. Treating that zero-second
    // entry as taste made an accidental click outrank an older completed film.
    return 0;
  }

  function entryKpId(entry) {
    if (/^\d+$/.test(String(entry?.kpId || ""))) return String(entry.kpId);
    const target = entry?.target;
    if ((target?.kind === "kp" || target?.kind === "clps") && /^\d+$/.test(String(target?.kpId || ""))) {
      return String(target.kpId);
    }
    return "";
  }

  // Builds weighted seeds plus the exclusion sets (everything the user already
  // watched or bookmarked must never be recommended back).
  function buildSeeds() {
    const history = loadStore("alphy.history");
    const bookmarks = loadStore("alphy.bookmarks");
    const bookmarkKeys = new Set(bookmarks.map((b) => b.key));

    const excludeKp = new Set();
    const excludeTitles = new Set();
    const byKp = new Map();
    const unresolved = [];

    const consider = (entry, weight) => {
      const title = normTitle(entry.title);
      if (title) excludeTitles.add(title);
      const kpId = entryKpId(entry);
      if (!kpId) {
        if (entry.title) unresolved.push({ entry, weight });
        return;
      }
      excludeKp.add(kpId);
      const existing = byKp.get(kpId);
      if (!existing || existing.weight < weight) {
        byKp.set(kpId, { kpId, weight, title: entry.title || "" });
      }
    };

    for (const entry of history) {
      const engagement = engagementWeight(entry);
      const bookmarked = bookmarkKeys.has(entry.key);
      if (engagement > 0) {
        let weight = recencyWeight(entry.updatedAt, 45) * engagement;
        if (bookmarked) weight *= 1.15;
        consider(entry, weight);
      } else if (bookmarked) {
        // A bookmark is an explicit positive signal even when playback never
        // started. Preserve it when the same title also has a zero-second entry.
        consider(entry, 0.5 * recencyWeight(entry.addedAt || entry.updatedAt, 90));
      } else {
        const title = normTitle(entry.title);
        if (title) excludeTitles.add(title);
        const kpId = entryKpId(entry);
        if (kpId) excludeKp.add(kpId);
      }
    }
    const historyKeys = new Set(history.map((h) => h.key));
    for (const entry of bookmarks) {
      if (historyKeys.has(entry.key)) continue;
      consider(entry, 0.5 * recencyWeight(entry.addedAt, 90));
    }

    const seeds = [...byKp.values()].sort((a, b) => b.weight - a.weight).slice(0, MAX_SEEDS);
    unresolved.sort((a, b) => b.weight - a.weight);
    return { seeds, unresolved, excludeKp, excludeTitles };
  }

  // --- kpId backfill for zen/nd history entries ----------------------------
  // Curated (zen) and newdeaf plays store no kpId. Resolve it once by title
  // through the SAME dedicated key pool, verify by normalized title + year,
  // then write it back into the stored entry so it never costs again.

  async function lookupKpId(title, year) {
    const cacheKey = `${LOOKUP_PREFIX}${normTitle(title)}|${year || ""}`;
    const cached = lsGet(cacheKey);
    if (cached != null) return cached || "";
    let found = "";
    try {
      const data = await apiGet(`/api/v2.1/films/search-by-keyword?keyword=${encodeURIComponent(title)}&page=1`);
      const films = Array.isArray(data?.films) ? data.films : [];
      const wanted = normTitle(title);
      const wantedYear = Number(String(year || "").slice(0, 4)) || 0;
      for (const film of films) {
        const names = [film.nameRu, film.nameEn].map(normTitle).filter(Boolean);
        if (!names.includes(wanted)) continue;
        const filmYear = Number(String(film.year || "").match(/\d{4}/)?.[0]) || 0;
        if (wantedYear && filmYear && Math.abs(wantedYear - filmYear) > 1) continue;
        const kpId = String(film.filmId || film.kinopoiskId || "");
        if (/^\d+$/.test(kpId)) { found = kpId; break; }
      }
    } catch (error) {
      if (error.code === "budget") throw error;
      log("lookup failed", title, error.message);
      lsSet(cacheKey, "", NEGATIVE_TTL);
      return "";
    }
    lsSet(cacheKey, found, found ? LOOKUP_TTL : NEGATIVE_TTL);
    return found;
  }

  function persistKpId(entryKey, kpId) {
    for (const storeKey of ["alphy.history", "alphy.bookmarks"]) {
      try {
        const list = loadStore(storeKey);
        const entry = list.find((item) => item.key === entryKey);
        if (entry && !entry.kpId) {
          entry.kpId = kpId;
          localStorage.setItem(storeKey, JSON.stringify(list));
        }
      } catch { /* ignore */ }
    }
  }

  // --- similars + candidate meta -------------------------------------------

  async function fetchSimilars(kpId) {
    const cached = lsGet(`${SIM_PREFIX}${kpId}`);
    if (cached) return cached;
    let items = [];
    try {
      const data = await apiGet(`/api/v2.2/films/${encodeURIComponent(kpId)}/similars`);
      items = (Array.isArray(data?.items) ? data.items : [])
        .filter((item) => /^\d+$/.test(String(item?.filmId || "")))
        .slice(0, 24)
        .map((item) => ({
          id: String(item.filmId),
          ru: item.nameRu || item.nameOriginal || item.nameEn || "",
          orig: item.nameOriginal || item.nameEn || "",
          poster: item.posterUrl || item.posterUrlPreview || "",
        }));
    } catch (error) {
      if (error.code === "budget") throw error;
      log("similars failed", kpId, error.message);
      lsSet(`${SIM_PREFIX}${kpId}`, [], NEGATIVE_TTL);
      return [];
    }
    // Films with no similars are cached too — a stable, cheap negative.
    lsSet(`${SIM_PREFIX}${kpId}`, items, items.length ? SIM_TTL : SIM_TTL / 2);
    return items;
  }

  function appMetaFor(kpId) {
    // The app's own meta cache (populated by search/watch flows) is free —
    // use it even when expired, display data does not go stale in a week.
    try {
      const raw = localStorage.getItem(`alphy.cache.meta:${kpId}`) ||
        localStorage.getItem(`alphy.cache.metasummary:${kpId}`);
      if (!raw) return null;
      return JSON.parse(raw)?.v || null;
    } catch {
      return null;
    }
  }

  function normalizeFilmMeta(film) {
    const year = Number(String(film?.year ?? "").match(/\d{4}/)?.[0]) || null;
    const rating = {};
    const kp = film?.rating?.kp ?? film?.ratingKinopoisk;
    const imdb = film?.rating?.imdb ?? film?.ratingImdb;
    if (Number.isFinite(Number(kp)) && Number(kp) > 0) rating.kp = Number(kp);
    if (Number.isFinite(Number(imdb)) && Number(imdb) > 0) rating.imdb = Number(imdb);
    return {
      metaLevel: (film?.description || film?.shortDescription || film?.imdbId || film?.externalId?.imdb)
        ? "full"
        : "summary",
      title: film?.title || film?.nameRu || film?.nameOriginal || film?.nameEn || "",
      originalTitle: film?.originalTitle || film?.nameOriginal || film?.nameEn || "",
      year: year ? String(year) : "",
      isSeries: film?.isSeries ?? (
        !!film?.serial || /SERIES|TV_SHOW|MINI|tv-series|animated-series/i.test(String(film?.type || ""))
      ),
      movieLength: Number.isFinite(Number(film?.movieLength ?? film?.filmLength))
        ? Number(film.movieLength ?? film.filmLength)
        : null,
      rating,
      poster: film?.poster || film?.posterUrl || film?.posterUrlPreview || "",
      description: film?.description || film?.shortDescription || "",
      shortDescription: film?.shortDescription || "",
      slogan: film?.slogan || "",
      ageRating: Number(String(film?.ageRating ?? film?.ratingAgeLimits ?? "").match(/\d+/)?.[0]) || null,
      ratingMpaa: film?.ratingMpaa || "",
      genres: (film?.genres || []).map((entry) => entry?.genre || entry).filter(Boolean).slice(0, 6),
      countries: (film?.countries || []).map((entry) => entry?.country || entry).filter(Boolean).slice(0, 4),
      externalId: {
        imdb: film?.externalId?.imdb || film?.externalIds?.imdb || film?.imdbId || "",
        tmdb: film?.externalId?.tmdb || film?.externalIds?.tmdb || film?.tmdbId || "",
      },
    };
  }

  function cardMetaComplete(meta) {
    return meta?.metaLevel === "full" || (
      !!meta?.year && [meta?.rating?.kp, meta?.rating?.imdb].some((value) => Number(value) > 0)
    );
  }

  async function fetchMetaBatch(kpIds) {
    const ids = [...new Set((Array.isArray(kpIds) ? kpIds : [])
      .map(String).filter((id) => /^\d+$/.test(id)))].slice(0, MAX_META_BATCH_SIZE);
    const result = new Map();
    const missing = [];
    for (const id of ids) {
      const cached = lsGet(`${META_PREFIX}${id}`) || appMetaFor(id);
      if (cached) result.set(id, cached);
      if (!cardMetaComplete(cached)) missing.push(id);
    }
    if (!missing.length) return result;
    // The same film objects supply watch pages and recommendation cards. Every
    // distinct title is fetched once for all visitors, preserving the full row.
    await promisePool(missing.map((id) => async () => {
      try {
        const film = await directUnofficialGet(`/api/v2.2/films/${encodeURIComponent(id)}`, { card: true });
        const meta = normalizeFilmMeta(film);
        lsSet(`${META_PREFIX}${id}`, meta, META_TTL);
        result.set(id, meta);
      } catch (error) { log("shared meta unavailable", id, error.message); }
    }), 4);
    return result;
  }

  async function promisePool(jobs, size) {
    const queue = [...jobs];
    const workers = Array.from({ length: Math.min(size, queue.length) }, async () => {
      while (queue.length) {
        const job = queue.shift();
        await job();
      }
    });
    await Promise.all(workers);
  }

  // --- scoring ---------------------------------------------------------------
  // Weighted reciprocal-rank fusion keeps each title's already-good ordering
  // meaningful. Consensus still helps, but a generic film near the tail of
  // several lists must not beat the first recommendation of a strong seed.
  function scoreCandidates(seedSimilars, excludeKp, excludeTitles) {
    const candidates = new Map();
    for (const { seed, similars } of seedSimilars) {
      similars.forEach((candidate, index) => {
        if (excludeKp.has(candidate.id)) return;
        if (excludeTitles.has(normTitle(candidate.ru))) return;
        const contribution = seed.weight / (2.5 + index * 0.8);
        let entry = candidates.get(candidate.id);
        if (!entry) {
          entry = { ...candidate, score: 0, hits: 0, primarySeed: seed.kpId, primaryContribution: 0 };
          candidates.set(candidate.id, entry);
        }
        entry.score += contribution;
        entry.hits += 1;
        if (contribution > entry.primaryContribution) {
          entry.primaryContribution = contribution;
          entry.primarySeed = seed.kpId;
        }
      });
    }
    const ranked = [...candidates.values()]
      .map((entry) => ({
        ...entry,
        final: entry.score * (1 + 0.10 * Math.min(3, entry.hits - 1)),
      }))
      .sort((a, b) => b.final - a.final);

    // Diversity guard: one hot seed must not own the whole row.
    const perSeed = new Map();
    const picked = [];
    for (const entry of ranked) {
      const used = perSeed.get(entry.primarySeed) || 0;
      if (used >= MAX_PER_SEED) continue;
      perSeed.set(entry.primarySeed, used + 1);
      picked.push(entry);
      if (picked.length >= ROW_SIZE) break;
    }
    return picked;
  }

  function toCuratedItem(candidate, meta) {
    return {
      id: `fy-${candidate.id}`,
      key: `kp:${candidate.id}`,
      title: candidate.ru || candidate.orig || `KP ${candidate.id}`,
      originalTitle: candidate.orig || "",
      year: meta?.year ? String(meta.year) : "",
      poster: meta?.poster || candidate.poster || "",
      isSeries: !!meta?.isSeries,
      movieLength: Number.isFinite(Number(meta?.movieLength)) ? Number(meta.movieLength) : null,
      rating: meta?.rating || {},
      externalId: meta?.externalId || {},
      description: meta?.description || "",
      shortDescription: meta?.shortDescription || "",
      ageRating: meta?.ageRating ?? null,
      ratingMpaa: meta?.ratingMpaa || "",
      genres: meta?.genres || [],
      countries: meta?.countries || [],
      target: { kind: "kp", kpId: candidate.id },
    };
  }

  // --- pipeline ---------------------------------------------------------------

  function fingerprint(seeds) {
    return seeds.map((seed) => `${seed.kpId}:${seed.weight.toFixed(2)}`).join(",");
  }

  function publish(items) {
    state.items = items.length >= MIN_ROW ? items : [];
    try {
      localStorage.setItem(LAST_KEY, JSON.stringify({ items: state.items, at: Date.now() }));
    } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent("alphy:foryou"));
  }

  async function compute() {
    if (state.mode !== "on" && state.mode !== "frozen") return;
    if (state.computing) {
      state.queued = true;
      return;
    }
    state.computing = true;
    const network = state.mode === "on";
    try {
      const { seeds, unresolved, excludeKp, excludeTitles } = buildSeeds();
      for (const id of hiddenIds()) excludeKp.add(id);

      // Backfill kpIds for a few title-only entries (zen/newdeaf plays).
      if (network && seeds.length < MAX_SEEDS && unresolved.length) {
        let lookups = 0;
        for (const { entry, weight } of unresolved) {
          if (lookups >= MAX_LOOKUP_PER_RUN || seeds.length >= MAX_SEEDS) break;
          const cached = lsGet(`${LOOKUP_PREFIX}${normTitle(entry.title)}|${entry.year || ""}`);
          if (cached === null) lookups += 1; // a real network lookup
          const kpId = await lookupKpId(entry.title, entry.year).catch(() => "");
          if (!kpId) continue;
          persistKpId(entry.key, kpId);
          excludeKp.add(kpId);
          if (!seeds.some((seed) => seed.kpId === kpId)) {
            seeds.push({ kpId, weight, title: entry.title });
          }
        }
        seeds.sort((a, b) => b.weight - a.weight);
      }

      state.lastFingerprint = fingerprint(seeds);
      state.lastComputeAt = Date.now();
      if (!seeds.length) {
        publish([]);
        return;
      }

      // Similars: cache first, then budgeted fetches for the heaviest seeds.
      const seedSimilars = [];
      const missing = [];
      for (const seed of seeds) {
        const cached = lsGet(`${SIM_PREFIX}${seed.kpId}`);
        if (cached) seedSimilars.push({ seed, similars: cached });
        else missing.push(seed);
      }
      if (network && missing.length) {
        const jobs = missing.slice(0, MAX_SIM_FETCH_PER_RUN).map((seed) => async () => {
          const similars = await fetchSimilars(seed.kpId).catch(() => []);
          if (similars.length) seedSimilars.push({ seed, similars });
        });
        await promisePool(jobs, FETCH_CONCURRENCY);
      }
      if (!seedSimilars.length) {
        publish([]);
        return;
      }

      const picked = scoreCandidates(seedSimilars, excludeKp, excludeTitles);

      // First paint with whatever meta is already local (app cache / own cache).
      const metaFor = new Map();
      for (const candidate of picked) {
        const local = lsGet(`${META_PREFIX}${candidate.id}`) || appMetaFor(candidate.id);
        if (local) metaFor.set(candidate.id, local);
      }
      publish(picked.map((candidate) => toCuratedItem(candidate, metaFor.get(candidate.id))));

      // Enrich gaps through the shared film objects used by watch pages too.
      if (network) {
        const gaps = picked.filter((candidate) => !cardMetaComplete(metaFor.get(candidate.id))).slice(0, MAX_META_BATCH_SIZE);
        if (gaps.length) {
          const fetched = await fetchMetaBatch(gaps.map((candidate) => candidate.id)).catch(() => new Map());
          for (const [id, meta] of fetched) metaFor.set(id, meta);
          publish(picked.map((candidate) => toCuratedItem(candidate, metaFor.get(candidate.id))));
        }
      }
      log("computed", { seeds: seeds.length, items: state.items.length, fetchesToday: fetchesToday() });
    } catch (error) {
      log("compute failed", error.message);
    } finally {
      state.computing = false;
      if (state.queued) {
        state.queued = false;
        compute();
      }
    }
  }

  function maybeCompute() {
    if (state.mode !== "on" && state.mode !== "frozen") return;
    const { seeds } = buildSeeds();
    const changed = fingerprint(seeds) !== state.lastFingerprint;
    if (!changed && Date.now() - state.lastComputeAt < RECOMPUTE_MIN_MS) return;
    if (!changed && state.items.length) return;
    compute();
  }

  // --- descriptive extras (жанр / страна / возраст / режиссёр / актёры) -------
  //
  // The resolver's /movie already carries all of this for kp: titles, so this is
  // only the backfill for targets that have no kinopoisk.dev document behind them
  // (zen:, ort:, nd: …). Cached for 30 days: a film's director does not change.
  // Two calls at most, once per title, ever.

  const EXTRAS_PREFIX = "alphy.foryou.extras.v3.";

  function personNames(staff, professionKey, limit) {
    const out = [];
    for (const person of Array.isArray(staff) ? staff : []) {
      if (String(person?.professionKey || "") !== professionKey) continue;
      const name = String(person?.nameRu || person?.nameEn || "").trim();
      if (name && !out.includes(name)) out.push(name);
      if (out.length >= limit) break;
    }
    return out;
  }

  function personRefs(staff, professionKey, limit) {
    const out = [];
    const seen = new Set();
    for (const person of Array.isArray(staff) ? staff : []) {
      if (String(person?.professionKey || "") !== professionKey) continue;
      const id = String(person?.staffId || person?.personId || "");
      const name = String(person?.nameRu || person?.nameEn || "").trim();
      if (!/^\d+$/.test(id) || !name || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, name });
      if (out.length >= limit) break;
    }
    return out;
  }

  async function filmExtras(kpId, { network = true } = {}) {
    const id = String(kpId || "");
    if (!/^\d+$/.test(id)) return null;
    const cacheKey = `${EXTRAS_PREFIX}${id}`;
    const cached = lsGet(cacheKey);
    if (cached) return cached;
    if (!network) return null;
    if (await whenModeReady() !== "on") return null;
    try {
      const localFilm = appMetaFor(id);
      const [film, staff] = await Promise.all([
        localFilm?.metaLevel === "full"
          ? Promise.resolve(localFilm)
          : apiGet(`/api/v2.2/films/${encodeURIComponent(id)}`).catch(() => null),
        apiGet(`/api/v1/staff?filmId=${encodeURIComponent(id)}`).catch(() => null),
      ]);
      if (!film && !staff) return null;
      const normalized = normalizeFilmMeta(film || {});
      const extras = {
        ...normalized,
        kpId: id,
        metaLevel: film ? "full" : "summary",
        genres: normalized.genres,
        countries: normalized.countries,
        ageRating: normalized.ageRating,
        ratingMpaa: normalized.ratingMpaa,
        slogan: normalized.slogan,
        directors: personNames(staff, "DIRECTOR", 3),
        cast: personNames(staff, "ACTOR", 8),
        people: {
          directors: personRefs(staff, "DIRECTOR", 3),
          cast: personRefs(staff, "ACTOR", 8),
        },
      };
      lsSet(cacheKey, extras, META_TTL);
      return extras;
    } catch (error) {
      log("extras failed", id, error.message);
      return null;
    }
  }

  // --- «Похожее» -------------------------------------------------------------
  //
  // Same engine, different question. «Для вас» asks "what fits this viewer?";
  // «Похожее» asks "what fits THIS title, for this viewer?". The candidate pool is
  // therefore always the current title's own similars, so the row stays honestly
  // about what is on screen — the taste graph only re-orders it.
  //
  // Cost, by construction:
  //   • the pool is one /similars call, cached 30 days, in the SAME namespace
  //     «Для вас» uses — so opening a title either costs nothing (already known)
  //     or costs one call that also improves the homepage row later;
  //   • the affinity signal reads only ALREADY-CACHED seed similars, never
  //     fetches;
  //   • posters/titles come from the similars payload itself; year/rating paint
  //     from caches first, then shared film objects fill missing card metadata
  //     with bounded concurrency. External candidate lists remain unchanged.

  // Affinity = "how connected is this candidate to what the viewer already
  // likes", computed purely from cached seed→similars edges. Zero network.
  function affinityIndex(excludeSeedId) {
    const { seeds } = buildSeeds();
    const affinity = new Map();
    let max = 0;
    for (const seed of seeds) {
      if (String(seed.kpId) === String(excludeSeedId)) continue;
      const similars = lsGet(`${SIM_PREFIX}${seed.kpId}`);
      if (!Array.isArray(similars) || !similars.length) continue;
      similars.forEach((candidate, index) => {
        const contribution = seed.weight / (1 + index * 0.12);
        const next = (affinity.get(candidate.id) || 0) + contribution;
        affinity.set(candidate.id, next);
        if (next > max) max = next;
      });
    }
    return { affinity, max };
  }

  function rankSimilars(base, kpId) {
    const { excludeKp, excludeTitles } = buildSeeds();
    const hidden = hiddenIds();
    const { affinity, max } = affinityIndex(kpId);

    return base
      .filter((candidate) => {
        if (String(candidate.id) === String(kpId)) return false;
        if (hidden.has(String(candidate.id))) return false;
        // Already watched or bookmarked: recommending it back is the single most
        // "forced" thing this row could do.
        if (excludeKp.has(String(candidate.id))) return false;
        return !excludeTitles.has(normTitle(candidate.ru));
      })
      .map((candidate, index) => {
        // Kinopoisk's own ordering is a real relevance signal, so it sets the
        // baseline; taste multiplies it rather than overriding it.
        const positional = 1 / (1 + index * 0.10);
        const taste = max > 0 ? (affinity.get(candidate.id) || 0) / max : 0;
        return { ...candidate, score: positional * (1 + SIMILAR_TASTE_WEIGHT * taste), taste };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, SIMILAR_ROW_SIZE);
  }

  // Returns curated-shaped items for the watch page, or [] when there is nothing
  // worth showing. `network: false` keeps it strictly cache-only.
  async function similarRow(kpId, { network = true } = {}) {
    const id = String(kpId || "");
    if (!/^\d+$/.test(id)) return [];
    const cached = lsGet(`${SIM_PREFIX}${id}`);
    let base = Array.isArray(cached) ? cached : null;
    if (!base) {
      if (!network) return [];
      if (await whenModeReady() !== "on") return [];
      base = await fetchSimilars(id).catch(() => []);
    } else if (state.mode === "off") {
      return [];
    }
    if (!base.length) return [];
    const picked = rankSimilars(base, id);
    if (picked.length < SIMILAR_MIN_ROW) return [];
    // Metadata is best-effort and free: whatever the app or our own cache already
    // knows. A missing year or rating just renders as absent.
    return picked.map((candidate) =>
      toCuratedItem(candidate, lsGet(`${META_PREFIX}${candidate.id}`) || appMetaFor(candidate.id)));
  }

  async function enrichSimilarRow(kpId) {
    const id = String(kpId || "");
    if (!/^\d+$/.test(id) || await whenModeReady() !== "on") return similarRow(id, { network: false });
    const base = lsGet(`${SIM_PREFIX}${id}`);
    if (!Array.isArray(base) || !base.length) return [];
    const picked = rankSimilars(base, id);
    if (picked.length < SIMILAR_MIN_ROW) return [];
    const meta = await fetchMetaBatch(picked.map((candidate) => candidate.id)).catch(() => new Map());
    return picked.map((candidate) =>
      toCuratedItem(candidate, meta.get(candidate.id) || lsGet(`${META_PREFIX}${candidate.id}`) || appMetaFor(candidate.id)));
  }

  // --- public surface -----------------------------------------------------

  function setMode(mode) {
    const next = mode === "frozen" || mode === "off" ? mode : "on";
    resolveModeReady(next);
    if (state.mode === next) return;
    state.mode = next;
    if (next === "off") {
      state.items = [];
      window.dispatchEvent(new CustomEvent("alphy:foryou"));
      return;
    }
    compute();
  }

  // Instant paint on load: yesterday's row is still a good row.
  try {
    const last = JSON.parse(localStorage.getItem(LAST_KEY) || "null");
    if (Array.isArray(last?.items)) state.items = last.items;
  } catch { /* ignore */ }

  window.addEventListener("alphy:view", (event) => {
    if (event.detail?.view === "home") maybeCompute();
  });

  window.alphyForYou = {
    setMode,
    getMode: () => state.mode,
    getItems: () => {
      if (state.mode === "off") return [];
      const hidden = hiddenIds();
      return hidden.size
        ? state.items.filter((item) => !hidden.has(String(item?.target?.kpId || "")))
        : state.items;
    },
    hide,
    refresh: () => compute(),
    similarRow,
    enrichSimilarRow,
    enrichItems: async (kpIds) => fetchMetaBatch(kpIds),
    filmExtras,
    unofficialGet: directUnofficialGet,
    // Title -> kpId, verified by normalized title + year and cached for 30 days.
    // Curated zen:/ort: targets carry no Kinopoisk id, and without one there are
    // no similars and no credits for them. One lookup unlocks both, and the same
    // answer later seeds «Для вас».
    resolveKpId: async (title, year) => {
      if (!title) return "";
      if (await whenModeReady() !== "on") return "";
      return lookupKpId(title, year).catch(() => "");
    },
    budgetLeft,
    _test: {
      buildSeeds, scoreCandidates, normTitle, recencyWeight, engagementWeight,
      toCuratedItem, hiddenIds, rankSimilars, affinityIndex, personNames, personRefs,
      directUnofficialUrl, directUnofficialGet,
      sharedTarget, sharedUnofficialGet, kpObjectUrl, kpPlacementGroup, apiGet, fetchMetaBatch,
    },
  };
})();
