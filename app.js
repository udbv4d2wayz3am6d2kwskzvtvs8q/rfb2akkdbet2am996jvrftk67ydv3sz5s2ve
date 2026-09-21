(() => {
  "use strict";

  // =====================================================================
  // AlphyTV — static client. The browser does everything except the two
  // things it can't: PoiskKino (token must stay server-side) and a cold Zona
  // kpId->Zenith cache fill (needs a trusted non-RU egress IP). The hot Zona
  // path is shared Supabase Storage; Deno/Vercel only fill a missing identity.
  // Newdeaf and LiftW search are fetched from THIS browser
  // (per-user IP), never from a server. Everything resolved is cached in
  // localStorage so returning users do not repeat the same provider requests.
  // =====================================================================

  // Keep in sync with the <title> in index.html — that one covers the first paint
  // and anything that reads the page without running JS; this one covers every
  // client-side route change afterwards.
  const SITE_TITLE = "Alphy TV — каталог фильмов и сериалов.";

  const STORE_RESOLVER = "alphy.resolverBaseUrl";
  const STORE_BOOKMARKS = "alphy.bookmarks";
  const STORE_HISTORY = "alphy.history";
  const STORE_SIMILAR_COLLAPSED = "alphy.similarCollapsed";
  const STORE_AGE_CACHE_MIGRATION = "alphy.migration.ageRating.v1";
  const CACHE_PREFIX = "alphy.cache.";
  // Older builds cached a transient empty Newdeaf result for six hours. Keep
  // this namespace versioned so those false misses cannot survive an upgrade.
  const ND_SEARCH_CACHE_NS = "ndsearch.v2";
  const LIFTW_SEARCH_CACHE_NS = "liftwsearch.v1";
  // api.liftw.ws is blocked in Russia AND sends no CORS header of any kind, so
  // the page can never read it directly — the relay below is the only route.
  // It rides the same rotating Supabase projects as the Letterboxd lookup:
  // spreading the workaround over several hostnames is the whole point, since
  // putting it on one would rebuild the single blockable name we are escaping.
  // A shard that has not been given the function yet answers 404 and simply
  // falls through to the next, so widening the ring is a deploy, not a release.
  const LIFTW_ENDPOINTS = [
    "https://icmjgvlsyfqwyewvsuje.supabase.co/functions/v1/liftw",
    "https://gzwynsvcydynqidwxjru.supabase.co/functions/v1/liftw",
    "https://cuyofxgofmhdugauoqzt.supabase.co/functions/v1/liftw",
    "https://hrtnvhafwzimjstvegno.supabase.co/functions/v1/liftw",
    "https://pvwrwsnzqaldyuvlttlv.supabase.co/functions/v1/liftw",
  ];
  const LIFTW_COOLDOWN_MS = 5 * 60e3;
  // Letterboxd publishes no API and sends no CORS header, so the lookup runs on
  // independently deployed Supabase Edge shards. The film's IMDb id picks its
  // primary shard for stable cache locality; the rest form its failover ring.
  // lcld... is intentionally retired: its management token is gone and keeping
  // an undeployable function in the active ring would reintroduce version drift.
  const LETTERBOXD_ENDPOINTS = [
    "https://icmjgvlsyfqwyewvsuje.supabase.co/functions/v1/letterboxd",
    "https://gzwynsvcydynqidwxjru.supabase.co/functions/v1/letterboxd",
    "https://cuyofxgofmhdugauoqzt.supabase.co/functions/v1/letterboxd",
    "https://hrtnvhafwzimjstvegno.supabase.co/functions/v1/letterboxd",
    "https://pvwrwsnzqaldyuvlttlv.supabase.co/functions/v1/letterboxd",
  ];
  // Zona identities are tiny and stable. A browser reads one immutable public
  // Storage object; only a miss enters the paired Edge function. The function
  // serializes that miss and lets the existing resolver fill it once for every
  // user, so Vercel/Deno usage follows new titles rather than DAU.
  const ZONA_CACHE_SHARDS = [
    "cuyofxgofmhdugauoqzt",
    "hrtnvhafwzimjstvegno",
    "hcuhanruaclhiltpdegc",
    "matozzgmaranfemgxpzy",
  ];
  const ZONA_SLOT_MS = 30 * 24 * 3600e3;
  const LETTERBOXD_CACHE_NS = "letterboxd.v1";
  const LETTERBOXD_REVIEWS_NS = "letterboxd.reviews.v1";
  // "Our table has never looked this film up" — a fact about our cache, not about
  // Letterboxd, so it lives apart from the verdicts above and is never read by
  // the watch page, which is what fills it in.
  const LETTERBOXD_UNKNOWN_NS = "letterboxd.unknown.v1";
  // The function reads at most this many ids per call and ignores the rest.
  const LETTERBOXD_BATCH_MAX = 60;
  // Every grid on a page shares one queue. The home page renders a dozen rows in
  // the same moment, and asking per row sent one request per row per shard.
  const LETTERBOXD_BATCH_WINDOW_MS = 40;
  // Letterboxd scores out of 5. It is stored and linked out at its true scale,
  // and only ever doubled for display, so it reads on the same 0-10 footing as
  // the Кинопоиск and IMDb figures it sits beside. Doubling is exact, so this
  // loses nothing; one decimal is all a 0-5 score with two decimals can carry.
  const letterboxdOutOfTen = (score) => (Number(score) * 2).toFixed(1);
  const LETTERBOXD_COOLDOWN_MS = 5 * 60e3;
  // v2: v1 could hold a relay's copy of the player page, whose media 410 in the browser.
  const LIFTW_TITLE_CACHE_NS = "liftwtitle.v2";
  const LIFTW_KP_OF_CACHE_NS = "liftwkpof.v2";
  const LIFTW_BY_KP_CACHE_NS = "liftwbykp.v2";
  // The player is reached directly, not through the relay: lift3.ws serves the
  // same embed with `Access-Control-Allow-Origin: *`, so the HTML and then the
  // video come straight to the browser and no stream ever crosses our servers.
  // Two hosts because neither reaches everyone: embed.liftw.ws is blocked in
  // Russia, and lift3.ws answers 422 to addresses its operator dislikes (a VPN
  // exit on a hosting ASN gets it; a domestic address and AWS both pass).
  const LIFTW_EMBED_HOSTS = ["lift3.ws", "embed.liftw.ws"];
  const LIFTW_CDN_ORIGINS = [
    "https://hye1eaipby4w.interkh.com",
    "https://ghzbfjzbazc.interkh.com",
    "https://x-bc.interkh.com",
  ];
  // v1 may contain fuzzy Batman->Lego Batman metadata written by older builds.
  const ND_ENRICHED_CACHE_NS = "ndenriched.v2";
  const ND_RECOMMEND_CACHE_NS = "ndrecommend.v1";
  const SHAKA_SCRIPT_URL = "https://cdn.jsdelivr.net/npm/shaka-player@4.11.17/dist/shaka-player.compiled.js";
  const HLS_SCRIPT_URL = "https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js";
  const SOAP_CDN_ORIGIN = "https://cdn-r11.soap4youand.me";
  const COLLAPS_BASE_URL = "https://plapi.cdnvideohub.com/api/v1/player/sv";
  const COLLAPS_PREVIEW_LIMIT = 1;
  const COLLAPS_PREVIEW_IDLE_TIMEOUT = 3500;
  const COLLAPS_PREVIEW_COOLDOWN_MS = 20 * 60e3;
  const REZKA_PREVIEW_LIMIT = 1;
  const REZKA_PREVIEW_COOLDOWN_MS = 20 * 60e3;
  const COLLAPS_FAST_PATH_TIMEOUT_MS = 1400;
  const ZENITH_BROWSER_FAST_WINDOW_MS = 1400;
  // The resolver itself hands the SAME payload to every client for a full hour
  // (ZENITH_FRESH_MS in resolver-deno/main.js) and can serve it stale for a day,
  // so a 20-minute client copy is strictly more conservative than what the server
  // already guarantees — and it turns a reopened title into zero network before
  // Shaka. An expired signature still cannot strand playback: a load failure
  // re-resolves with forceWorker.
  const ZENITH_PARSED_CACHE_MS = 20 * 60e3;
  // Whether THIS browser can reach api.zenithjs.ws directly is a property of the
  // network, not of the tab. Remembering it only in sessionStorage made the first
  // click of every new session burn the full fast window on a fetch that was
  // already known to fail.
  const ZENITH_DIRECT_BLOCK_MS = 12 * 3600e3;
  const COLLAPS_REFRESH_SEC = 240;
  // CDNVideoHub's field names are counterintuitive: empirical ffprobe checks
  // show type=7 (mpeg2kUrl) is 3840-wide, while type=6 (mpeg4kUrl) is 2560-wide.
  const COLLAPS_QUALITY_FIELDS = [
    ["mpeg2kUrl", "4K", 2160],
    ["mpeg4kUrl", "2K", 1440],
    ["mpegQhdUrl", "1440p", 1440],
    ["mpegFullHdUrl", "1080p", 1080],
    ["mpegHighUrl", "720p", 720],
    ["mpegMediumUrl", "480p", 480],
    ["mpegLowUrl", "360p", 360],
    ["mpegLowestUrl", "240p", 240],
    ["mpegTinyUrl", "144p", 144],
  ];
  const TTL = {
    search: 6 * 3600e3,
    ndsearch: 6 * 3600e3,
    liftwsearch: 60 * 60e3,
    // The signed CDN URLs inside a LiftW embed carry t=<unix> about ten days out,
    // so a six-hour parse cache never outlives the stream it points at — and a
    // reopened title costs zero network before Shaka. A load failure still
    // re-resolves with { force: true }.
    liftwtitle: 5 * 3600e3,
    // A LiftW id <-> Kinopoisk id pairing is an identity, not content: it cannot
    // go stale. A miss can (the catalogue grows), so it expires much sooner.
    liftwkp: 30 * 24 * 3600e3,
    liftwkpmiss: 6 * 3600e3,
    // A Letterboxd score moves in the second decimal over months, not hours.
    // A miss is almost always a series — which Letterboxd, being a film site,
    // will never carry — so it is worth remembering too, just not as long.
    letterboxd: 30 * 24 * 3600e3,
    letterboxdmiss: 7 * 24 * 3600e3,
    // A grid does not re-ask about a film our table had never seen for a day.
    // Opening the film ignores this and fills the table on the spot.
    letterboxdunknown: 24 * 3600e3,
    ndrecommend: 24 * 3600e3,
    ndrecommendMiss: 60 * 60e3,
    ndpage: 24 * 3600e3,
    clpsplaylist: 2 * 3600e3,
    clpsprobe: 6 * 3600e3,
    clpsmiss: 60 * 60e3,
    clpsvideo: 90e3,
    rezkamiss: 60 * 60e3,
    zona: 30 * 24 * 3600e3,
    zenith: 20 * 60e3,
    meta: 7 * 24 * 3600e3,
    credits: 30 * 24 * 3600e3,
    enriched: 30 * 24 * 3600e3,
    subtitles: 24 * 3600e3,
  };
  const WYZIE_BASE_URL = "https://sub.wyzie.io";
  const WYZIE_KEYS = [
    "wyzie-7qnppx8o6q5f7hqa0uxg8u739dv0tm8t",
    "wyzie-tzgfaqnbu5319z0yjl38l1lfun1cmv9t",
    "wyzie-qu8oh8trk1i63dsvqvbevylamzg5lpwu",
    "wyzie-c5dkfwmef9gdj8mi6hvjmjne2kgtdf1v",
    "wyzie-df0ppilx82fhonhekq55hg2q3lqu8wzv",
  ];
  const WYZIE_LANGUAGES = ["ru", "en"];

  const params = new URLSearchParams(location.search);
  const DEBUG = params.has("debug");
  const isLocal = /^(127\.0\.0\.1|localhost)$/i.test(location.hostname);
  // Samsung's Tizen browser is uniquely sensitive to work on the page's main
  // thread while video is decoding. Keep this narrower than weakVideoDevice():
  // low-core phones and other TVs retain the regular player behaviour.
  const TIZEN_VIDEO_MODE = samsungTizenVideoDevice();
  if (TIZEN_VIDEO_MODE) document.documentElement.classList.add("tizen-video-mode");

  const el = {
    logoBtn: document.getElementById("logoBtn"),
    searchInput: document.getElementById("searchInput"),
    searchBtn: document.getElementById("searchBtn"),
    searchSuggest: document.getElementById("searchSuggest"),
    bookmarksToggle: document.getElementById("bookmarksToggle"),
    bookmarksNavCount: document.getElementById("bookmarksNavCount"),
    settingsPanel: document.getElementById("settingsPanel"),
    resolverInput: document.getElementById("resolverInput"),
    saveResolverBtn: document.getElementById("saveResolverBtn"),
    healthBtn: document.getElementById("healthBtn"),
    resolverState: document.getElementById("resolverState"),
    homeView: document.getElementById("homeView"),
    continueSection: document.getElementById("continueSection"),
    continueHeader: document.getElementById("continueHeader"),
    continueGrid: document.getElementById("continueGrid"),
    bookmarksView: document.getElementById("bookmarksView"),
    bookmarksCount: document.getElementById("bookmarksCount"),
    bookmarksGrid: document.getElementById("bookmarksGrid"),
    bookmarksEmpty: document.getElementById("bookmarksEmpty"),
    searchView: document.getElementById("searchView"),
    resultsTitle: document.getElementById("resultsTitle"),
    resultsGrid: document.getElementById("resultsGrid"),
    soapView: document.getElementById("soapView"),
    soapFilter: document.getElementById("soapFilter"),
    soapToggle: document.getElementById("soapToggle"),
    soapCount: document.getElementById("soapCount"),
    soapGrid: document.getElementById("soapGrid"),
    soapBrowseBtn: document.getElementById("soapBrowseBtn"),
    watchView: document.getElementById("watchView"),
    watchTitle: document.getElementById("watchTitle"),
    playerHost: document.getElementById("playerHost"),
    serialPanel: document.getElementById("serialPanel"),
    trackPanel: document.getElementById("trackPanel"),
    metaPanel: document.getElementById("metaPanel"),
    similarSection: document.getElementById("similarSection"),
    similarRow: document.getElementById("similarRow"),
    similarToggle: document.getElementById("similarToggle"),
    reviewsSection: document.getElementById("reviewsSection"),
    reviewsLink: document.getElementById("reviewsLink"),
    reviewsList: document.getElementById("reviewsList"),
    reviewsToggle: document.getElementById("reviewsToggle"),
    loading: document.getElementById("loading"),
    error: document.getElementById("error"),
  };

  const state = {
    resolverBaseUrl: "",
    playerPlaceholder: "",
    player: null,
    hls: null,
    videoEl: null,
    currentTarget: null,
    audioNames: [],
    blockedAudioNames: [],
    sources: {},
    opravar: null,
    serial: null,
    collaps: null,
    rezka: null,
    currentMeta: null,
    zenithEmbedUrl: "",
    playerReady: false,
    // Ortified progress is reported from the srcdoc player every ~4s. We coalesce
    // the localStorage write (see onOrtProgress) so weak TV browsers don't stall
    // the shared event loop on every tick; the newest tick lives here until flush.
    pendingOrtEntry: null,
    lastOrtWriteAt: 0,
    trackInterval: null,
    trackContext: null,
    tizenPlayIntentUntil: 0,
    playbackRate: 1,
    playbackHistoryKey: "",
    // These are the viewer's desired tracks, rather than just whatever fallback
    // happens to be active in the current episode. Keeping the desired value lets
    // a dub/subtitle return automatically after one episode temporarily lacks it.
    audioPreference: null,
    subtitlePreference: null,
    subtitleRequest: {
      loading: false,
      error: "",
      message: "",
    },
    subtitleObjectUrls: [],
    // Subtitle sync: the raw subtitles we fetched (so the offset control can
    // re-render them shifted), the current global offset, the open state of the
    // ⚙ control, and the Shaka text-track ids superseded by a shifted copy
    // (4.11 has no removeTextTrack, so we hide stale tracks from the menu).
    loadedSubs: [],
    subtitleOffset: 0,
    subtitleOffsetOpen: false,
    subtitleOffsetBusy: false,
    staleTextTrackIds: [],
  };

  // Monotonic token: every route bumps it; any async chain whose token is no
  // longer current bails before touching the player/UI (the "плеер не туда" bug).
  let resolveToken = 0;
  const nextToken = () => (resolveToken += 1);
  const isStale = (token) => token !== resolveToken;
  const newdeafWarmOrigins = new Set();
  const newdeafPagePrefetches = new Set();
  const newdeafPageInflight = new Map();
  const newdeafRecommendationInflight = new Map();
  const liftwByKpInflight = new Map();
  const recommendationContextByKp = new Map();
  const soapWarmOrigins = new Set();
  const soapManifestPrefetches = new Set();
  const collapsWarmOrigins = new Set();
  const rezkaWarmOrigins = new Set();
  const collapsProbeInflight = new Map();
  const collapsVideoInflight = new Map();
  const rezkaProbeInflight = new Map();
  const embedTextCache = new Map();
  const embedTextInflight = new Map();
  const zenithParsedCache = new Map();
  const zenithParsedInflight = new Map();
  const liftwTitleInflight = new Map();
  let liftwMediaBridge = null;
  let liftwOpaqueSchemeRegistered = false;
  let liftwManifestFetcher = null;
  const externalScriptPromises = new Map();
  const preparedTargets = new Set();
  // Hover prefetch budget. This used to be a plain countdown that, once spent,
  // disabled hover warming for the REST OF THE SESSION — four hovers on the
  // homepage and every later click paid full resolve latency again. It is now a
  // token bucket: a burst of hovers is still capped, but browsing for a while
  // earns the budget back.
  const SPECULATIVE_BUDGET_MAX = 6;
  const SPECULATIVE_REFILL_MS = 15e3;
  let speculativeIntentBudget = SPECULATIVE_BUDGET_MAX;
  let speculativeRefillAt = Date.now();
  // A recommendation warm-up races three client-side catalogues. Allow it for
  // one hover per tab; pointer-down is never budgeted. This prevents a casual
  // mouse sweep from crawling every provider while still warming a likely click.
  let speculativeRecommendationBudget = 1;

  function claimSpeculativeIntent() {
    const now = Date.now();
    const earned = Math.floor((now - speculativeRefillAt) / SPECULATIVE_REFILL_MS);
    if (earned > 0) {
      speculativeIntentBudget = Math.min(SPECULATIVE_BUDGET_MAX, speculativeIntentBudget + earned);
      speculativeRefillAt = now;
    }
    if (speculativeIntentBudget <= 0) return false;
    speculativeIntentBudget -= 1;
    return true;
  }

  // =====================================================================
  // localStorage: TTL cache + bookmarks + history
  // =====================================================================
  function cacheGet(ns, key) {
    try {
      const raw = localStorage.getItem(`${CACHE_PREFIX}${ns}:${key}`);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (obj.exp && Date.now() > obj.exp) {
        localStorage.removeItem(`${CACHE_PREFIX}${ns}:${key}`);
        return null;
      }
      return obj.v;
    } catch {
      return null;
    }
  }
  function cacheSet(ns, key, value, ttlMs) {
    const storageKey = `${CACHE_PREFIX}${ns}:${key}`;
    const payload = JSON.stringify({ v: value, exp: ttlMs ? Date.now() + ttlMs : 0 });
    try {
      localStorage.setItem(storageKey, payload);
    } catch {
      freeCacheSpace();
      try { localStorage.setItem(storageKey, payload); } catch { /* still full — session runs on network */ }
    }
  }
  // Silent quota failures used to drop the ortmeta/curatedmeta handoff between the
  // homepage and the watch page, leaving Ortified titles with a bare sidebar.
  // Reclaim space from our own TTL cache instead: expired entries first, then the
  // oldest-expiring third. History/bookmarks/foryou storage is never touched.
  function dropExpiredCache() {
    const doomed = [];
    try {
      const now = Date.now();
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i) || "";
        // foryou.js uses the same {v, exp} envelope but deletes expired entries
        // only on read — sims of films that left history are never read again,
        // so without this sweep they would accumulate forever (~4KB per film).
        // Its non-TTL keys (quota counters, hidden.v1, last.v1) carry no exp
        // field and are therefore never treated as expired.
        if (!key.startsWith(CACHE_PREFIX) && !key.startsWith("alphy.foryou.")) continue;
        let exp = 0;
        try { exp = JSON.parse(localStorage.getItem(key) || "{}").exp || 0; } catch { exp = 1; }
        if (exp && exp <= now) doomed.push(key);
      }
      doomed.forEach((key) => localStorage.removeItem(key));
    } catch { /* ignore */ }
    return doomed.length;
  }
  function containsLegacyZeroAge(value) {
    if (!value || typeof value !== "object") return false;
    if (Object.prototype.hasOwnProperty.call(value, "ageRating") && value.ageRating === 0) return true;
    return Object.values(value).some(containsLegacyZeroAge);
  }
  function dropLegacyZeroAgeCache() {
    try {
      if (localStorage.getItem(STORE_AGE_CACHE_MIGRATION) === "1") return;
      const doomed = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i) || "";
        if (!key.startsWith(CACHE_PREFIX)) continue;
        try {
          const envelope = JSON.parse(localStorage.getItem(key) || "null");
          if (containsLegacyZeroAge(envelope?.v)) doomed.push(key);
        } catch { /* malformed TTL entries expire through the normal cache path */ }
      }
      doomed.forEach((key) => localStorage.removeItem(key));
      localStorage.setItem(STORE_AGE_CACHE_MIGRATION, "1");
    } catch { /* storage may be unavailable in strict privacy modes */ }
  }
  function freeCacheSpace() {
    if (dropExpiredCache()) return;
    try {
      const entries = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i) || "";
        if (!key.startsWith(CACHE_PREFIX)) continue;
        let exp = Infinity;
        try { exp = JSON.parse(localStorage.getItem(key) || "{}").exp || Infinity; } catch { exp = 0; }
        entries.push({ key, exp });
      }
      entries.sort((a, b) => a.exp - b.exp);
      entries.slice(0, Math.max(10, Math.ceil(entries.length / 3))).forEach((entry) => {
        localStorage.removeItem(entry.key);
      });
    } catch { /* ignore */ }
  }
  function loadList(storeKey) {
    try {
      const v = JSON.parse(localStorage.getItem(storeKey) || "[]");
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }
  function saveList(storeKey, value) {
    const payload = JSON.stringify(value);
    try {
      localStorage.setItem(storeKey, payload);
    } catch {
      freeCacheSpace();
      try { localStorage.setItem(storeKey, payload); } catch { /* ignore */ }
    }
  }

  // =====================================================================
  // soap4you static movie catalog. All 1212 titles + their HLS master URLs
  // are shipped as one static JSON — playback hits soap's CDN directly
  // (account-free), so browsing/search/lists need no backend at all.
  // =====================================================================
  const soapMovies = new Map();   // id -> { id, t, q, w, m, a, s }
  let soapMoviesList = [];
  let soapCatalogLoaded = null;
  function soapPoster(id) {
    return `https://soap4youand.me/assets/covers/movies/${encodeURIComponent(id)}.jpg`;
  }
  function loadSoapCatalog() {
    if (soapCatalogLoaded) return soapCatalogLoaded;
    const catalogUrl = window.__alphyAssetUrl?.("soap-movies.json") || "/soap-movies.json";
    soapCatalogLoaded = fetch(catalogUrl, { cache: "force-cache", credentials: "omit" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        soapMoviesList = (data && data.movies) || [];
        soapMovies.clear();
        for (const m of soapMoviesList) soapMovies.set(String(m.id), m);
        warmSoapConnections(soapMoviesList[0]?.m);
        return soapMoviesList;
      })
      .catch(() => {
        soapCatalogLoaded = null; // allow a later retry
        return [];
      });
    return soapCatalogLoaded;
  }
  function soapSearch(query, { fourKOnly = false, limit = 0 } = {}) {
    const q = String(query || "").trim().toLowerCase();
    let list = fourKOnly ? soapMoviesList.filter((m) => m.q === "4K") : soapMoviesList;
    if (q) list = list.filter((m) => String(m.t || "").toLowerCase().includes(q));
    list = [...list].sort((a, b) => String(a.t).localeCompare(String(b.t)));
    return limit ? list.slice(0, limit) : list;
  }
  function soapQualityLabel(m) {
    return m.q === "4K" ? "4K UHD" : m.q === "720" ? "720p" : `${m.q}p`;
  }
  // Curated-list item shape (matches catalog.js normalizeItem) for a soap movie.
  function soapListItem(m) {
    return {
      id: crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
      key: `soap:${m.id}`,
      title: m.t,
      year: "",
      poster: soapPoster(m.id),
      isSeries: false,
      target: { kind: "soap", soapId: String(m.id) },
      cachedAt: new Date().toISOString(),
    };
  }

  // =====================================================================
  // Collaps / CDNvideohub. Browser-only path:
  // KP id -> public playlist -> video/{vkId} -> progressive OK.ru MP4.
  // HLS/DASH exist but okcdn does not expose CORS for MSE, so keep this source
  // on plain <video src=mp4> and re-resolve fresh signed URLs in the browser.
  // =====================================================================
  function collapsTarget(kpId, selection = {}) {
    const target = { kind: "clps", kpId: String(kpId || "") };
    const season = positiveInt(selection.season);
    const episode = positiveInt(selection.episode);
    if (season) target.season = season;
    if (episode) target.episode = episode;
    return target;
  }

  function rezkaTarget(rezkaId, kpId = null) {
    const target = { kind: "rezka", rezkaId: String(rezkaId || "") };
    if (/^\d+$/.test(String(kpId || ""))) target.kpId = String(kpId);
    return target;
  }

  function rezkaListItem(hit, details = {}) {
    const target = rezkaTarget(hit.rezkaId, hit.kpId);
    return {
      id: crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
      key: keyFor(target),
      title: details.title || hit.title || `Фильм ${hit.rezkaId}`,
      year: details.year || hit.year || "",
      poster: details.poster || hit.poster || "",
      description: details.description || "",
      isSeries: false,
      movieLength: details.movieLength || hit.movieLength || null,
      rating: details.rating || hit.rating || {},
      kpId: String(hit.kpId || ""),
      target,
      cachedAt: new Date().toISOString(),
    };
  }

  function collapsListItem(hit, details = {}) {
    const target = collapsTarget(hit.kpId, hit.selection || hit);
    const title = details.title || hit.title || `KP ${hit.kpId}`;
    return {
      id: crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
      key: keyFor(target),
      title,
      year: details.year || hit.year || "",
      poster: details.poster || hit.poster || "",
      description: details.description || "",
      isSeries: !!(details.isSeries ?? hit.isSeries),
      movieLength: details.movieLength || hit.movieLength || null,
      rating: details.rating || hit.rating || {},
      kpId: String(hit.kpId || ""),
      target,
      cachedAt: new Date().toISOString(),
    };
  }

  // Admin-only browser over the whole soap catalog: filter by name, toggle
  // 4K-only, click to play, "+" to add to a curated list. Pure client-side.
  async function showSoapBrowser() {
    setView("soap");
    warmSoapConnections();
    document.title = `soap — ${SITE_TITLE}`;
    if (el.soapFilter) el.soapFilter.value = "";
    if (state.soapFourKOnly == null) state.soapFourKOnly = true;
    await loadSoapCatalog();
    renderSoapBrowser();
    el.soapFilter?.focus();
  }
  function renderSoapBrowser() {
    if (!el.soapGrid) return;
    const fourK = state.soapFourKOnly !== false;
    const list = soapSearch(el.soapFilter?.value || "", { fourKOnly: fourK });
    if (list.length) prefetchTopSoapManifest(list);
    if (el.soapToggle) el.soapToggle.textContent = fourK ? "Показать все" : "Только 4K";
    if (el.soapCount) el.soapCount.textContent = String(list.length);
    const frag = document.createDocumentFragment();
    for (const m of list) {
      const target = { kind: "soap", soapId: String(m.id) };
      const card = makeCard({
        title: m.t,
        sub: soapQualityLabel(m),
        poster: soapPoster(m.id),
        bookmark: { target, details: { title: m.t, poster: soapPoster(m.id), year: "" } },
        onClick: () => go(`/m/${m.id}`),
        onAdd: () => window.alphyCatalog?.addToList?.(soapListItem(m)),
      });
      frag.appendChild(card);
    }
    el.soapGrid.replaceChildren(frag);
    layoutMobileGrid(el.soapGrid);
  }

  function keyFor(t) {
    if (!t) return "x";
    if (t.key) return t.key;
    if (t.kind === "kp") return `kp:${t.kpId}`;
    if (t.kind === "zen") return `zen:${t.zenithId}`;
    if (t.kind === "ort") return `ort:${t.embedUrl}`;
    if (t.kind === "opr") return `opr:${t.playerUrl}`;
    if (t.kind === "nd") return `nd:${t.pageUrl}`;
    if (t.kind === "soap") return `soap:${t.soapId}`;
    if (t.kind === "lift") return `lift:${t.liftId}`;
    if (t.kind === "clps") return `clps:${t.kpId}`;
    if (t.kind === "rezka") return `rezka:${t.rezkaId}`;
    return "x";
  }
  function cleanTarget(t) {
    const keepKpId = (target) => {
      const kpId = String(t?.kpId || "");
      return /^\d+$/.test(kpId) ? { ...target, kpId } : target;
    };
    if (t.kind === "kp") return { kind: "kp", kpId: t.kpId };
    if (t.kind === "zen") return keepKpId({ kind: "zen", zenithId: t.zenithId });
    if (t.kind === "ort") return keepKpId({ kind: "ort", embedUrl: t.embedUrl });
    if (t.kind === "opr") return keepKpId({ kind: "opr", playerUrl: t.playerUrl, pageUrl: t.pageUrl || "" });
    if (t.kind === "nd") return keepKpId({ kind: "nd", pageUrl: t.pageUrl });
    if (t.kind === "soap") return { kind: "soap", soapId: String(t.soapId) };
    if (t.kind === "lift") return keepKpId(liftwTarget(t.liftId, t));
    if (t.kind === "clps") return collapsTarget(t.kpId, t);
    if (t.kind === "rezka") return rezkaTarget(t.rezkaId, t.kpId);
    return t;
  }
  function hashFor(t) {
    if (t.kind === "kp") return `/k/${encodeURIComponent(t.kpId)}`;
    if (t.kind === "zen") return `/${encodeURIComponent(t.zenithId)}`;
    if (t.kind === "ort") return shortOrtifiedPath(t.embedUrl) || legacyHashPath(`/watch/ort/${encodeURIComponent(t.embedUrl)}`);
    if (t.kind === "opr") return legacyHashPath(`/watch/opr/${encodeURIComponent(t.playerUrl)}`);
    if (t.kind === "nd") return shortNewdeafPath(t.pageUrl) || legacyHashPath(`/watch/nd/${encodeURIComponent(t.pageUrl)}`);
    if (t.kind === "soap") return `/m/${encodeURIComponent(t.soapId)}`;
    if (t.kind === "lift") {
      const path = `/l/${encodeURIComponent(t.liftId)}`;
      const season = positiveInt(t.season);
      const episode = positiveInt(t.episode);
      return season && episode ? `${path}/s${season}e${episode}` : path;
    }
    if (t.kind === "rezka") {
      const path = `/r/${encodeURIComponent(t.rezkaId)}`;
      return /^\d+$/.test(String(t.kpId || "")) ? `${path}/${encodeURIComponent(t.kpId)}` : path;
    }
    if (t.kind === "clps") {
      const path = `/c/${encodeURIComponent(t.kpId)}`;
      const season = positiveInt(t.season);
      const episode = positiveInt(t.episode);
      return season && episode ? `${path}/s${season}e${episode}` : path;
    }
    return "/";
  }

  function validHistoryKpId(...values) {
    for (const value of values) {
      const id = String(value || "");
      if (/^\d+$/.test(id)) return id;
    }
    return "";
  }

  function historyKpId(entry = {}, meta = {}) {
    const target = entry?.target || entry || {};
    return validHistoryKpId(
      entry?.kpId,
      meta?.kpId,
      target?.kpId,
      target?.kind === "kp" || target?.kind === "clps" ? target?.kpId : "",
    );
  }

  function canonicalHistoryKey(entry = {}, meta = {}) {
    const kpId = historyKpId(entry, meta);
    if (kpId) return `kp:${kpId}`;
    return String(entry?.key || keyFor(entry?.target || entry) || "x");
  }

  const HISTORY_META_FIELDS = [
    "title", "originalTitle", "alternativeName", "enName", "year", "poster", "backdrop",
    "description", "shortDescription", "slogan", "isSeries", "movieLength", "ageRating",
    "ratingMpaa", "rating", "votes", "externalId", "genres", "countries", "directors",
    "cast", "people", "kpId", "metaLevel",
  ];

  function historyEntryMeta(entry = {}) {
    const meta = entry?.meta && typeof entry.meta === "object" ? entry.meta : {};
    const top = {};
    for (const field of HISTORY_META_FIELDS) {
      if (entry?.[field] !== undefined && entry?.[field] !== null && entry?.[field] !== "") {
        top[field] = entry[field];
      }
    }
    return mergeMetadata(top, meta);
  }

  function historyMetaSnapshot(meta = {}, target = {}) {
    const source = mergeMetadata(meta, target);
    const snapshot = {};
    for (const field of HISTORY_META_FIELDS) {
      const value = source?.[field];
      if (value === undefined || value === null || value === "") continue;
      snapshot[field] = value;
    }
    const kpId = historyKpId(target, source);
    if (kpId) snapshot.kpId = kpId;
    return snapshot;
  }

  function mergeHistoryEntries(newer, older) {
    const meta = mergeMetadata(historyEntryMeta(newer), historyEntryMeta(older));
    const merged = { ...older, ...newer };
    merged.kpId = historyKpId(merged, meta) || undefined;
    merged.key = canonicalHistoryKey(merged, meta);
    merged.meta = historyMetaSnapshot(meta, merged.target || {});
    for (const field of ["title", "poster", "year", "movieLength", "kpId", "isSeries", "rating"]) {
      if (meta[field] !== undefined && meta[field] !== null && meta[field] !== "") merged[field] = meta[field];
    }
    // Opening a second provider creates a newer zero-second entry. Keep the real
    // progress from the older alias until the new provider reports playback.
    if (!(Number(newer?.duration) > 0) && Number(older?.duration) > 0) {
      merged.position = older.position;
      merged.duration = older.duration;
      merged.progress = older.progress;
    }
    merged.updatedAt = Math.max(Number(newer?.updatedAt) || 0, Number(older?.updatedAt) || 0);
    return merged;
  }

  function collapseHistory(entries) {
    const sorted = [...(Array.isArray(entries) ? entries : [])]
      .filter((entry) => entry?.target || entry?.key)
      .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
    const byKey = new Map();
    for (const raw of sorted) {
      const entry = { ...raw, key: canonicalHistoryKey(raw, historyEntryMeta(raw)) };
      const previous = byKey.get(entry.key);
      byKey.set(entry.key, previous ? mergeHistoryEntries(previous, entry) : mergeHistoryEntries(entry, {}));
    }
    return [...byKey.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  function historyEntryFor(ref) {
    const routeKey = typeof ref === "string" ? ref : keyFor(ref);
    const canonical = typeof ref === "string" ? ref : canonicalHistoryKey(ref, state.currentMeta || {});
    return collapseHistory(loadList(STORE_HISTORY)).find((entry) => (
      entry.key === canonical || entry.key === routeKey || keyFor(entry.target) === routeKey
    ));
  }

  function recordHistory(entry) {
    const kpId = historyKpId(entry, entry.meta || state.currentMeta || {});
    const normalized = {
      ...entry,
      ...(kpId ? { kpId } : {}),
      key: canonicalHistoryKey(entry, entry.meta || state.currentMeta || {}),
      meta: historyMetaSnapshot(entry.meta || state.currentMeta || historyEntryMeta(entry), entry.target || {}),
    };
    let hist = collapseHistory(loadList(STORE_HISTORY));
    if (normalized.snapshot) {
      hist = hist.map((item) => item.key === normalized.key ? item : ({ ...item, snapshot: "" }));
    }
    const i = hist.findIndex((h) => h.key === normalized.key);
    const prev = i >= 0 ? hist[i] : null;
    const merged = mergeHistoryEntries({ ...(prev || {}), ...normalized, updatedAt: Date.now() }, prev || {});
    // A replay whose caches rotted (expired ortmeta, bare deep link) must never
    // blank out metadata an earlier session already stored — progress reporters
    // pass whatever the current target knows, which can be nothing.
    if (prev) {
      for (const field of ["title", "poster", "year", "movieLength", "kpId", "isSeries", "snapshot"]) {
        if (!merged[field] && prev[field]) merged[field] = prev[field];
      }
      // rating flows through mergeMetadata and arrives as {} when unknown.
      const ratingEmpty = !merged.rating || !Object.values(merged.rating).some((v) => v);
      if (ratingEmpty && prev.rating && Object.values(prev.rating).some((v) => v)) merged.rating = prev.rating;
    }
    if (i >= 0) hist[i] = merged;
    else hist.unshift(merged);
    hist.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    saveList(STORE_HISTORY, hist.slice(0, 30));
  }
  function recordOpen(target) {
    const kpId = historyKpId(target, state.currentMeta || {});
    if (kpId) target.kpId = kpId;
    const key = canonicalHistoryKey(target, state.currentMeta || {});
    const existing = historyEntryFor(target);
    recordHistory({
      key,
      kind: target.kind,
      target: cleanTarget(target),
      // Kinopoisk id when known — the "Для вас" recommender seeds from it.
      kpId: kpId || existing?.kpId,
      title: target.title || existing?.title || "",
      poster: target.poster || existing?.poster || "",
      year: target.year || existing?.year || "",
      rating: state.currentMeta?.rating || existing?.rating,
      movieLength: state.currentMeta?.movieLength || existing?.movieLength,
      isSeries: state.currentMeta?.isSeries ?? target.isSeries ?? existing?.isSeries ?? false,
      position: existing?.position || 0,
      duration: existing?.duration || 0,
      progress: existing?.progress || 0,
      meta: historyMetaSnapshot(state.currentMeta || {}, target),
    });
  }
  // Late kpId attach: zen/nd/ort plays learn their Kinopoisk id only after the
  // metadata enrichment lands. Persist it into the existing history entry
  // without bumping updatedAt so the recommender can seed from these plays too.
  function attachHistoryKpId(key, kpId) {
    if (!key || !/^\d+$/.test(String(kpId || ""))) return;
    const hist = loadList(STORE_HISTORY);
    const entry = hist.find((h) => h.key === key || keyFor(h.target) === key);
    if (!entry) return;
    entry.kpId = String(kpId);
    if (entry.target) entry.target = cleanTarget({ ...entry.target, kpId: String(kpId) });
    entry.meta = historyMetaSnapshot({ ...historyEntryMeta(entry), kpId: String(kpId) }, entry.target || {});
    saveList(STORE_HISTORY, collapseHistory(hist));
  }

  // Recover title/poster/year for a target that carries no kpId (Ortified), e.g.
  // when reopened from Continue/Bookmarks where the URL is just the embed. Falls
  // back to whatever the history/bookmark entry kept so the watch tab is never bare.
  function storedMeta(key) {
    const entry = historyEntryFor(key) || loadList(STORE_BOOKMARKS).find((x) => x.key === key || keyFor(x.target) === key);
    return entry ? historyEntryMeta(entry) : null;
  }

  // Ortified/Opravar targets carry no kpId, so their sidebar lives entirely on the
  // localStorage relay (ortmeta/oprmeta cache -> history entry). When both rot
  // (TTL expiry, quota, a bare replay), recover from the published admin catalog —
  // the same data the homepage cards render from. One same-origin fetch a session.
  let curatedCatalogItemsPromise = null;
  function curatedCatalogItems() {
    if (!curatedCatalogItemsPromise) {
      curatedCatalogItemsPromise = (async () => {
        const grab = async (url) => {
          const response = await fetch(url, { cache: "no-cache" });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.json();
        };
        let blobUrl = "";
        try { blobUrl = String((await grab("/curated-config.json")).blobUrl || ""); } catch { /* fall through */ }
        let payload = null;
        if (blobUrl) { try { payload = await grab(blobUrl); } catch { /* fall through */ } }
        if (!payload) { try { payload = await grab("/curated-live.json"); } catch { /* fall through */ } }
        if (!payload) {
          const fallbackUrl = window.__alphyAssetUrl?.("curated-fallback.json") || "/curated-fallback.json";
          try { payload = await grab(fallbackUrl); } catch { return []; }
        }
        const items = [];
        for (const list of payload?.lists || []) {
          for (const item of list?.items || []) if (item?.key) items.push(item);
        }
        return items;
      })().catch(() => []);
    }
    return curatedCatalogItemsPromise;
  }
  // Ort series keys in the admin catalog carry whatever query string the embed was
  // added with (historically even duplicated params like ?season=1&episode=1&episode=1),
  // while the router reconstructs a clean one — and series meta is the same for every
  // episode anyway. Compare ort keys by their base embed URL, query stripped.
  function curatedKeyBase(key) {
    const raw = String(key || "");
    if (!raw.startsWith("ort:")) return raw;
    try {
      const url = new URL(raw.slice(4));
      return `ort:${url.origin}${url.pathname}`;
    } catch {
      return raw;
    }
  }
  async function findCuratedMeta(key) {
    const items = await curatedCatalogItems();
    const base = curatedKeyBase(key);
    const item = items.find((x) => curatedKeyBase(x.key) === base);
    if (!item) return null;
    return {
      title: item.title || "",
      year: item.year || "",
      poster: item.poster || "",
      description: item.description || "",
      isSeries: !!item.isSeries,
      movieLength: item.movieLength || null,
      rating: item.rating || undefined,
      kpId: item.kpId || undefined,
      ageRating: item.ageRating ?? undefined,
      ratingMpaa: item.ratingMpaa || undefined,
      genres: item.genres || [],
      countries: item.countries || [],
      directors: item.directors || [],
      cast: item.cast || [],
      people: item.people || { directors: [], cast: [] },
    };
  }
  // Fire-and-forget heal for a watch page that opened with rotted/partial meta.
  // Re-renders the sidebar, refreshes the meta cache, and writes the recovered
  // title/poster/year back into history so the entry stops being invisible to
  // Continue-watching and the recommender.
  function healWatchMeta(target, token, baseMeta, cacheNs, cacheKey, fallbackHead) {
    findCuratedMeta(keyFor(target)).then((curated) => {
      if (!curated || isStale(token) || state.currentTarget !== target) return;
      const merged = mergeMetadata(baseMeta || {}, curated);
      if (!merged.title && !merged.poster) return;
      cacheSet(cacheNs, cacheKey, merged, TTL.enriched);
      target.title = merged.title || target.title;
      target.poster = merged.poster || target.poster;
      target.year = merged.year || target.year;
      if (merged.isSeries) target.isSeries = true;
      setWatchHead(target.title || fallbackHead, target);
      renderMeta(merged, target);
      recordOpen(target);
    }).catch(() => {});
  }

  function resumePosition(key) {
    const e = historyEntryFor(key);
    if (!e || !e.duration) return 0;
    if (e.progress >= 0.95) return 0;
    return e.position > 5 ? e.position : 0;
  }
  function savedAudioLang(key) {
    return historyEntryFor(key)?.audioLang || null;
  }
  function savedAudioPreference(key) {
    const entry = historyEntryFor(key);
    return cleanAudioPreference(entry?.audioPreference || entry?.audioLang);
  }
  function savedSubtitlePreference(key) {
    return cleanSubtitlePreference(historyEntryFor(key)?.subtitlePreference);
  }
  function savedOpravarSelection(key) {
    return historyEntryFor(key)?.opravarSelection || null;
  }
  function savedCollapsSelection(key) {
    return historyEntryFor(key)?.collapsSelection || null;
  }
  function savedSerialSelection(key) {
    return historyEntryFor(key)?.serialSelection || null;
  }
  function activePlaybackHistoryKey() {
    return state.playbackHistoryKey || state.trackContext?.histKey || state.serial?.histKey || keyFor(state.currentTarget);
  }
  function persistPlaybackPreferences(fields) {
    const t = state.currentTarget;
    if (!t || !fields || typeof fields !== "object") return;
    recordHistory({
      key: activePlaybackHistoryKey(), kind: t.kind, target: cleanTarget(t),
      title: t.title || "", poster: t.poster || "", year: t.year || "", ...fields,
    });
  }
  function persistAudioPreference(value) {
    const preference = cleanAudioPreference(value);
    if (!preference) return;
    state.audioPreference = preference;
    persistPlaybackPreferences({
      audioLang: preference.tag || preference.language || "",
      audioPreference: preference,
    });
  }
  function persistSubtitlePreference(value) {
    const preference = cleanSubtitlePreference(value);
    if (!preference) return;
    state.subtitlePreference = preference;
    persistPlaybackPreferences({ subtitlePreference: preference });
  }

  function isBookmarked(key) {
    return loadList(STORE_BOOKMARKS).some((b) => b.key === key);
  }
  function toggleBookmark(target, details = {}) {
    const key = keyFor(target);
    let bms = loadList(STORE_BOOKMARKS);
    let added = false;
    if (bms.some((b) => b.key === key)) {
      bms = bms.filter((b) => b.key !== key);
    } else {
      added = true;
      bms.unshift({
        key,
        kind: target.kind,
        target: cleanTarget(target),
        title: details.title || target.title || "",
        poster: details.poster || target.poster || "",
        year: details.year || target.year || "",
        rating: details.rating || target.rating || {},
        movieLength: details.movieLength || target.movieLength || null,
        isSeries: details.isSeries ?? target.isSeries ?? false,
        addedAt: Date.now(),
      });
    }
    saveList(STORE_BOOKMARKS, bms.slice(0, 100));
    updateBookmarkBtn(state.currentTarget);
    syncBookmarkControls(key);
    updateBookmarksNav();
    return added;
  }
  function updateBookmarkBtn(target) {
    if (!target) return;
    syncBookmarkControls(keyFor(target));
  }

  function updateBookmarksNav() {
    const count = loadList(STORE_BOOKMARKS).length;
    el.bookmarksNavCount.textContent = String(count);
    el.bookmarksNavCount.classList.toggle("hidden", count === 0);
  }

  function syncBookmarkButton(button, key) {
    const on = isBookmarked(key);
    button.classList.toggle("on", on);
    button.setAttribute("aria-pressed", String(on));
    button.setAttribute("aria-label", on ? "Убрать из закладок" : "Добавить в закладки");
    button.title = on ? "Убрать из закладок" : "Добавить в закладки";
  }

  function syncBookmarkControls(key) {
    document.querySelectorAll(".card-bookmark").forEach((button) => {
      if (!key || button.dataset.bookmarkKey === key) {
        syncBookmarkButton(button, button.dataset.bookmarkKey);
      }
    });
  }

  function addCardBookmark(media, target, details = {}, onChange) {
    if (!target?.kind) return null;
    const key = keyFor(target);
    const button = document.createElement("button");
    button.className = "card-bookmark";
    button.type = "button";
    button.dataset.bookmarkKey = key;
    button.innerHTML = `
      <svg viewBox="0 0 24 30" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true">
        <path d="M3 1h18v27l-9-7-9 7z"></path>
      </svg>
    `;
    syncBookmarkButton(button, key);
    button.addEventListener("keydown", (event) => event.stopPropagation());
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const added = toggleBookmark(target, details);
      onChange?.(added);
    });
    media.appendChild(button);
    return button;
  }

  // =====================================================================
  // Autoplay policy
  //
  // Opening a title must not start sound on its own. Our own players therefore
  // mount PAUSED with the stream already buffering (preload="auto"), so the first
  // press of play is instant but it is the viewer's press. Third-party embeds
  // (Ortified / Zenith srcdoc iframes) run their own player and cannot be told
  // this from here.
  //
  // Playback that RESUMES after a quality/episode/voice switch is a different
  // thing: it restores a state the viewer already chose, so those call sites keep
  // their `wasPlaying`-guarded play() and do not go through here.
  // =====================================================================
  const AUTOPLAY_ON_OPEN = false;

  function mountPaused(video) {
    video.autoplay = AUTOPLAY_ON_OPEN;
    video.preload = "auto";
    return video;
  }

  function startPlaybackIfAllowed(video, { resume = false } = {}) {
    // Tizen loses the remote-control click's transient user activation while an
    // async resolver/player library loads. Retry play only for a genuine resume;
    // a freshly opened title still honours the global no-autoplay policy.
    const tizenIntent = TIZEN_VIDEO_MODE && (resume || state.tizenPlayIntentUntil > Date.now());
    if ((!AUTOPLAY_ON_OPEN && !tizenIntent) || !video) return;
    const play = () => {
      state.tizenPlayIntentUntil = 0;
      try { video.focus?.({ preventScroll: true }); } catch { /* old Tizen */ }
      video.play().catch(() => { /* user gesture may still be required */ });
    };
    if (video.readyState >= 2) play();
    else video.addEventListener("canplay", play, { once: true });
  }

  function loadExternalScript(name, src, ready) {
    if (ready()) return Promise.resolve();
    if (externalScriptPromises.has(name)) return externalScriptPromises.get(name);
    const pending = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = src;
      script.async = true;
      script.crossOrigin = "anonymous";
      script.dataset.alphyPlayer = name;
      script.addEventListener("load", () => {
        if (ready()) resolve();
        else reject(new Error(`${name} загрузился без ожидаемого API`));
      }, { once: true });
      script.addEventListener("error", () => reject(new Error(`Не удалось загрузить ${name}`)), { once: true });
      document.head.appendChild(script);
    }).catch((error) => {
      externalScriptPromises.delete(name);
      document.querySelector(`script[data-alphy-player="${name}"]`)?.remove();
      throw error;
    });
    externalScriptPromises.set(name, pending);
    return pending;
  }

  function ensureShaka() {
    return loadExternalScript("Shaka", SHAKA_SCRIPT_URL, () => !!window.shaka?.Player);
  }

  function ensureHls() {
    return loadExternalScript("hls.js", HLS_SCRIPT_URL, () => !!window.Hls);
  }

  // =====================================================================
  // Resolver client
  // =====================================================================
  async function resolverJson(path, { retries = 2, timeoutMs = 15000, fetchCache = "no-store" } = {}) {
    if (!state.resolverBaseUrl) throw new Error("Resolver URL не настроен");
    const url = /^https?:\/\//i.test(path) ? path : `${state.resolverBaseUrl}${path}`;
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, { cache: fetchCache, credentials: "omit", signal: controller.signal });
        const text = await response.text();
        let data;
        try { data = JSON.parse(text); } catch { data = { ok: false, raw: text.slice(0, 500) }; }
        if (!response.ok || data.ok === false) {
          const resolverError = new Error(data.message || data.error || `Resolver ${response.status}`);
          resolverError.code = data.error || "";
          resolverError.status = response.status;
          throw resolverError;
        }
        return data;
      } catch (error) {
        lastError = error;
        const aborted = error?.name === "AbortError";
        const transient =
          aborted ||
          Number(error?.status) >= 500 ||
          error?.code === "zona_upstream_empty" ||
          /NetworkError|Failed to fetch|load failed|terminated|network/i.test(String(error?.message || ""));
        if (!transient || attempt === retries) break;
        await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError || new Error("Resolver request failed");
  }

  // =====================================================================
  // Cached resolution layer (the request-minimization core)
  // =====================================================================
  function normalizeUnofficialClientMovie(item, { search = false } = {}) {
    const number = (value) => {
      if (value === null || value === undefined || value === "") return null;
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    };
    const year = String(item?.year ?? "").match(/\d{4}/)?.[0] || null;
    const isSeries = !!item?.serial || /SERIES|TV_SHOW|MINI/i.test(String(item?.type || ""));
    return {
      metaLevel: search ? "summary" : "full",
      kpId: item?.kinopoiskId ?? item?.filmId ?? null,
      name: item?.nameRu || item?.nameOriginal || item?.nameEn || null,
      alternativeName: item?.nameOriginal || item?.nameEn || null,
      enName: item?.nameEn || null,
      type: item?.type || null,
      year: year ? Number(year) : null,
      isSeries,
      movieLength: typeof item?.filmLength === "number" ? item.filmLength : null,
      description: item?.description || null,
      shortDescription: item?.shortDescription || null,
      slogan: item?.slogan || null,
      poster: item?.posterUrl || item?.posterUrlPreview || null,
      ageRating: Number(String(item?.ratingAgeLimits || "").match(/\d+/)?.[0]) || null,
      ratingMpaa: item?.ratingMpaa || null,
      genres: (item?.genres || []).map((entry) => entry?.genre).filter(Boolean),
      countries: (item?.countries || []).map((entry) => entry?.country).filter(Boolean),
      directors: [],
      cast: [],
      people: { directors: [], cast: [] },
      externalId: { imdb: item?.imdbId || null, tmdb: item?.tmdbId || null },
      rating: {
        kp: number(search ? item?.rating : item?.ratingKinopoisk),
        imdb: search ? null : number(item?.ratingImdb),
      },
      votes: {
        kp: search ? null : number(item?.ratingKinopoiskVoteCount),
        imdb: search ? null : number(item?.ratingImdbVoteCount),
      },
    };
  }

  async function directUnofficialJson(path) {
    const request = window.alphyForYou?.unofficialGet;
    if (typeof request !== "function") throw new Error("Shared metadata service unavailable");
    return request(path);
  }

  async function searchPoiskkino(query, year) {
    const ckey = `${query}|${year || ""}`;
    const cached = cacheGet("search", ckey);
    if (cached) return cached;
    // Enter needs the external catalogue, including titles absent from Lift.
    // One shared query object replaces per-viewer PoiskKino calls. Card details
    // fill after first paint through enrichSearchCardMetadata, not 12 blocking
    // film requests. Preview remains entirely on the static index.
    let data, degraded = false;
    try { data = await directUnofficialJson(`/api/v2.1/films/search-by-keyword?keyword=${encodeURIComponent(query)}&page=1`); }
    catch {
      degraded = true;
      const indexed = matchShard(await loadSearchRows(query), query, 12).filter((entry) => /^\d+$/.test(entry.kpId));
      data = { films: indexed.map((entry) => ({ filmId: Number(entry.kpId), nameRu: entry.title,
        nameEn: entry.originName, year: entry.year, type: entry.isSeries ? "TV_SERIES" : "FILM",
        posterUrl: `https://st.kp.yandex.net/images/film_iphone/iphone360/${entry.kpId}.jpg` })) };
    }
    let results = (Array.isArray(data?.films) ? data.films : []).slice(0, 12)
      .map((item) => normalizeUnofficialClientMovie(item, { search: true }));
    const wantedYear = Number.parseInt(year, 10);
    if (Number.isFinite(wantedYear)) {
      const near = results.filter((item) => Number.isFinite(Number(item.year)) && Math.abs(Number(item.year) - wantedYear) <= 1);
      if (near.length) results = near;
    }
    results = results.map((movie) => ({ ...movie, metaLevel: "summary" }));
    const sharedExpiry = Number(data?.__alphyFreshUntil);
    const searchTtl = Number.isFinite(sharedExpiry)
      ? (sharedExpiry > Date.now() ? Math.min(TTL.search, sharedExpiry - Date.now()) : 60e3)
      : TTL.search;
    cacheSet("search", ckey, results, degraded ? 60e3 : searchTtl);
    results.forEach((m) => m.kpId != null && cacheSet("metasummary", m.kpId, m, TTL.meta));
    return results;
  }

  function metadataIsFull(meta) {
    if (!meta || typeof meta !== "object") return false;
    if (meta.metaLevel === "full") return true;
    if (meta.metaLevel === "summary") return false;
    const external = meta.externalId || meta.externalIds || {};
    const hasDescription = !!(meta.description || meta.shortDescription);
    const hasRating = [meta.rating?.kp, meta.rating?.imdb].some((value) => Number(value) > 0);
    const hasIdentity = !!(external.imdb || meta.imdbId);
    return hasDescription && hasRating && hasIdentity;
  }

  function cacheMovieMetadata(kpId, meta, ttl = TTL.meta) {
    const id = String(kpId || "");
    if (!/^\d+$/.test(id) || !meta) return;
    cacheSet(metadataIsFull(meta) ? "meta" : "metasummary", id, meta, ttl);
  }

  const movieMetaInflight = new Map();
  async function fetchMovieMeta(kpId) {
    const cached = cacheGet("meta", kpId);
    if (metadataIsFull(cached)) return cached;
    const inflightKey = String(kpId || "");
    const inflight = movieMetaInflight.get(inflightKey);
    if (inflight) return inflight;
    const summary = cached || cacheGet("metasummary", kpId) || {};
    const pending = (async () => { try {
      // One shared Unofficial film object supplies IMDb identity, both ratings
      // and synopsis without spending provider quota again for each viewer.
      const raw = await directUnofficialJson(`/api/v2.2/films/${encodeURIComponent(kpId)}`);
      const movie = mergeMetadata(normalizeUnofficialClientMovie(raw), summary);
      movie.metaLevel = "full";
      cacheMovieMetadata(kpId, movie);
      return movie;
    } catch (error) {
      log("meta-warn", error.message);
      // Returning the existing summary keeps playback available while the
      // shared service recovers; no per-visitor PoiskKino fallback storm.
      if (Object.keys(summary).length) return summary;
    }
    return null;
    })().finally(() => movieMetaInflight.delete(inflightKey));
    movieMetaInflight.set(inflightKey, pending);
    return pending;
  }

  async function fetchCollapsJson(url, timeoutMs = 9000) {
    if (!isCollapsControlUrl(url)) throw new Error("Collaps: blocked control URL");
    // A normal cross-origin fetch would reveal https://alphy.tv in Origin even
    // with referrerPolicy=no-referrer. The sandbox has an opaque origin, so the
    // provider sees Origin:null while the request still leaves from the viewer's
    // own IP. Never fall back to a direct fetch here: privacy must fail closed.
    const text = await sandboxFetchText(url, "collaps", timeoutMs);
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 400) }; }
    return data;
  }

  function isCollapsControlUrl(value) {
    try {
      const url = new URL(value);
      return url.origin === "https://plapi.cdnvideohub.com" &&
        url.pathname.startsWith("/api/v1/player/sv/");
    } catch {
      return false;
    }
  }

  async function fetchCollapsPlaylist(kpId) {
    const id = String(kpId || "").trim();
    if (!/^\d+$/.test(id)) throw new Error("Collaps: invalid kpId");
    const cached = cacheGet("clpsplaylist", id);
    if (cached?.items?.length) return cached;
    const url = `${COLLAPS_BASE_URL}/playlist?pub=1&aggr=kp&id=${encodeURIComponent(id)}`;
    const data = await fetchCollapsJson(url);
    const playlist = normalizeCollapsPlaylist(data, id);
    if (playlist.items.length) cacheSet("clpsplaylist", id, playlist, TTL.clpsplaylist);
    return playlist;
  }

  async function fetchCollapsVideo(vkId, { force = false } = {}) {
    const id = String(vkId || "").trim();
    if (!id) throw new Error("Collaps: missing vkId");
    if (!force) {
      const cached = cacheGet("clpsvideo", id);
      if (cached?.sources?.length) return cached;
    }
    if (collapsVideoInflight.has(id)) return collapsVideoInflight.get(id);
    const pending = (async () => {
      const data = await fetchCollapsJson(`${COLLAPS_BASE_URL}/video/${encodeURIComponent(id)}`);
      const value = { raw: data, sources: normalizeCollapsSources(data?.sources || {}) };
      if (value.sources.length) cacheSet("clpsvideo", id, value, TTL.clpsvideo);
      return value;
    })().finally(() => collapsVideoInflight.delete(id));
    collapsVideoInflight.set(id, pending);
    return pending;
  }

  function normalizeCollapsPlaylist(data, kpId) {
    const items = (Array.isArray(data?.items) ? data.items : [])
      .map((item, index) => {
        const vkId = compact(item?.vkId || item?.videoId || item?.id || "");
        if (!vkId) return null;
        const season = positiveInt(item?.season);
        const episode = positiveInt(item?.episode);
        return {
          index,
          cvhId: compact(item?.cvhId || ""),
          vkId,
          voiceStudio: compact(item?.voiceStudio || item?.translation || item?.voice || ""),
          voiceType: compact(item?.voiceType || ""),
          name: compact(item?.name || item?.title || ""),
          ...(season ? { season } : {}),
          ...(episode ? { episode } : {}),
        };
      })
      .filter(Boolean);
    const isSerial = !!data?.isSerial || items.some((item) => item.season || item.episode);
    return {
      kpId: String(kpId || ""),
      titleName: compact(data?.titleName || data?.title || ""),
      isSerial,
      items,
    };
  }

  function normalizeCollapsSources(sources) {
    return COLLAPS_QUALITY_FIELDS
      .map(([key, label, height]) => {
        const url = compact(sources?.[key] || "");
        if (!/^https:\/\//i.test(url)) return null;
        return { key, label, height, url };
      })
      .filter(Boolean);
  }

  async function probeCollapsSearch(movies, token) {
    if (collapsPreviewOnCooldown()) return [];
    const candidates = (movies || [])
      .filter((movie) => /^\d+$/.test(String(movie?.kpId || "")))
      .slice(0, COLLAPS_PREVIEW_LIMIT)
      .map((movie, rank) => ({ ...movie, rank }));
    const out = [];
    let cursor = 0;
    const worker = async () => {
      while (!isStale(token) && cursor < candidates.length) {
        const movie = candidates[cursor];
        cursor += 1;
        try {
          const hit = await probeCollapsMovie(movie);
          if (hit) out.push(hit);
        } catch (error) {
          if (shouldCooldownCollapsPreview(error)) {
            setCollapsPreviewCooldown(error);
            break;
          }
          log("collaps-probe-item-warn", { kpId: movie?.kpId, message: error.message });
        }
      }
    };
    await Promise.all([worker(), worker()]);
    return out.sort((a, b) =>
      (Number(b.qualityHeight) >= 1440) - (Number(a.qualityHeight) >= 1440) ||
      Number(b.qualityHeight || 0) - Number(a.qualityHeight || 0) ||
      Number(a.rank || 0) - Number(b.rank || 0)
    );
  }

  async function probeCollapsMovie(movie) {
    const kpId = String(movie?.kpId || "");
    const cached = cacheGet("clpsprobe", kpId);
    if (cached?.kpId) return { ...cached, rank: movie.rank ?? 0 };
    if (cacheGet("clpsmiss", kpId)) return null;
    const inflightKey = kpId;
    if (collapsProbeInflight.has(inflightKey)) return collapsProbeInflight.get(inflightKey);
    const pending = (async () => {
      const playlist = await fetchCollapsPlaylist(kpId);
      const item = chooseCollapsProbeItem(playlist.items, movie?.selection);
      if (!item) {
        cacheSet("clpsmiss", kpId, true, TTL.clpsmiss);
        return null;
      }
      const video = await fetchCollapsVideo(item.vkId);
      const best = video.sources[0];
      if (!best) {
        cacheSet("clpsmiss", kpId, true, TTL.clpsmiss);
        return null;
      }
      const hit = {
        kpId,
        title: movieTitle(movie) || playlist.titleName || `KP ${kpId}`,
        year: movie?.year || "",
        poster: movie?.poster || "",
        rating: movie?.rating || {},
        movieLength: movie?.movieLength || null,
        isSeries: !!(playlist.isSerial || movie?.isSeries),
        qualityLabel: best.label,
        qualityHeight: best.height,
        selection: {
          ...(item.season ? { season: item.season } : {}),
          ...(item.episode ? { episode: item.episode } : {}),
        },
        rank: Number(movie?.rank || 0),
      };
      cacheSet("clpsprobe", kpId, hit, TTL.clpsprobe);
      return hit;
    })().finally(() => collapsProbeInflight.delete(inflightKey));
    collapsProbeInflight.set(inflightKey, pending);
    return pending;
  }

  function chooseCollapsProbeItem(items, selection = {}) {
    const list = Array.isArray(items) ? items : [];
    const season = positiveInt(selection?.season);
    const episode = positiveInt(selection?.episode);
    const requested = list.find((item) =>
      (!season || item.season === season) && (!episode || item.episode === episode));
    if (requested) return requested;
    return list.find((item) => item.season === 1 && item.episode === 1) ||
      list.find((item) => item.episode === 1) ||
      list[0] ||
      null;
  }

  function collapsPreviewOnCooldown() {
    return !!cacheGet("clpspreview", "cooldown");
  }

  function shouldCooldownCollapsPreview(error) {
    const status = Number(error?.status || String(error?.message || "").match(/\b(401|403|429)\b/)?.[1] || 0);
    if ([401, 403, 429].includes(status)) return true;
    return /Failed to fetch|NetworkError|Load failed|CORS|blocked/i.test(String(error?.message || ""));
  }

  function setCollapsPreviewCooldown(error) {
    cacheSet("clpspreview", "cooldown", {
      at: Date.now(),
      message: String(error?.message || error || "").slice(0, 120),
    }, COLLAPS_PREVIEW_COOLDOWN_MS);
  }

  function rezkaPreviewOnCooldown() {
    return !!cacheGet("rezkapreview", "cooldown");
  }

  function setRezkaPreviewCooldown(error) {
    cacheSet("rezkapreview", "cooldown", {
      at: Date.now(),
      message: String(error?.message || error || "").slice(0, 120),
    }, REZKA_PREVIEW_COOLDOWN_MS);
  }

  async function probeRezkaSearch(movies, token) {
    if (!rezkaLastResortEnabled() || rezkaPreviewOnCooldown()) return [];
    const movie = (movies || []).find((item) =>
      !item?.isSeries && /^\d+$/.test(String(item?.kpId || "")) && cleanMovieTitle(movieTitle(item))
    );
    if (!movie || isStale(token)) return [];
    const kpId = String(movie.kpId);
    if (cacheGet("rezkamiss", kpId)) return [];
    if (rezkaProbeInflight.has(kpId)) return rezkaProbeInflight.get(kpId);
    const pending = (async () => {
      try {
        const title = cleanMovieTitle(movieTitle(movie));
        const resolved = await resolveRezka({ title, year: movie.year || null });
        if (!resolved?.movie?.rezkaId || Number(resolved.best?.quality) < 720) return [];
        warmRezkaConnections(resolved);
        return [{
          kpId,
          rezkaId: String(resolved.movie.rezkaId),
          title: movieTitle(movie) || resolved.movie.title,
          year: movie.year || resolved.movie.year || "",
          poster: movie.poster || "",
          rating: movie.rating || {},
          movieLength: movie.movieLength || null,
          qualityLabel: "720p",
        }];
      } catch (error) {
        if (/not found|не найден|no working translator|no anonymous stream/i.test(String(error?.message || ""))) {
          cacheSet("rezkamiss", kpId, true, TTL.rezkamiss);
        } else {
          setRezkaPreviewCooldown(error);
        }
        throw error;
      }
    })().finally(() => rezkaProbeInflight.delete(kpId));
    rezkaProbeInflight.set(kpId, pending);
    return pending;
  }

  async function resolveZona(kpId) {
    const cached = cacheGet("zona", kpId);
    if (cached && cached.embedUrl) return cached;
    // Always resolve at the title level (no season/episode). mzona returns the
    // whole-series Zenith embed for a series; the episode is then chosen from
    // that embed's playlist client-side. Passing season/episode here makes
    // getVideoSources come back empty and breaks series that otherwise resolve.
    const id = String(kpId || "");
    const path = `/resolve-zona?kpId=${encodeURIComponent(id)}`;
    try {
      const shared = await resolveZonaShared(id);
      if (shared?.embedUrl) {
        const value = { zenithId: shared.zenithId, embedUrl: shared.embedUrl };
        cacheSet("zona", id, value, TTL.zona);
        return value;
      }
    } catch (error) {
      log("zona-shared-cache-fallback", { message: error.message });
    }
    const candidates = isLocal
      ? [{ url: path, timeoutMs: 6000 }]
      : [
          { url: new URL(`/api${path}`, location.origin).href, timeoutMs: 6500 },
          { url: path, timeoutMs: 6000 },
        ];
    let lastError;
    for (const candidate of candidates) {
      try {
        const data = await resolverJson(candidate.url, {
          retries: 0,
          timeoutMs: candidate.timeoutMs,
          fetchCache: "default",
        });
        if (!data.embedUrl) throw new Error("Zenith временно недоступен");
        const value = { zenithId: data.zenithId, embedUrl: data.embedUrl };
        cacheSet("zona", kpId, value, TTL.zona);
        return value;
      } catch (error) {
        lastError = error;
        log("zona-resolver-fallback", { candidate: candidate.url, message: error.message });
      }
    }
    throw lastError || new Error("Zenith временно недоступен");
  }

  function zonaPlacement(id) {
    let hash = 0;
    for (const char of String(id)) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
    return { hash, group: hash % 256 };
  }

  function zonaShardOrder(id) {
    const { hash } = zonaPlacement(id);
    const start = hash % ZONA_CACHE_SHARDS.length;
    return ZONA_CACHE_SHARDS.map((_, index) =>
      ZONA_CACHE_SHARDS[(start + index) % ZONA_CACHE_SHARDS.length]);
  }

  function zonaObjectPath(id, now = Date.now()) {
    const { group } = zonaPlacement(id);
    const slot = Math.floor(now / ZONA_SLOT_MS + group / 256);
    return `v1/${id}/${slot}.json`;
  }

  function validSharedZona(value, id) {
    if (!value || value.v !== 1 || String(value.kpId) !== String(id)) return null;
    if (!(Date.parse(value.freshUntil) > Date.now())) return null;
    const zenithId = String(value.zenithId || "");
    if (!/^\d+$/.test(zenithId)) return null;
    try {
      const embed = new URL(String(value.embedUrl || ""));
      if (embed.protocol !== "https:" || embed.hostname !== "api.zenithjs.ws" ||
          embed.pathname !== `/embed/movie/${zenithId}`) return null;
    } catch { return null; }
    return value;
  }

  async function zonaFetch(url, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        cache: "default", credentials: "omit", signal: controller.signal,
      });
      const data = await response.json().catch(() => null);
      return { response, data };
    } finally {
      clearTimeout(timer);
    }
  }

  async function zonaStorageHit(project, id, timeoutMs = 2200) {
    const path = zonaObjectPath(id);
    const url = `https://${project}.supabase.co/storage/v1/object/public/zona/${path}`;
    const { response, data } = await zonaFetch(url, timeoutMs);
    return response.ok ? validSharedZona(data, id) : null;
  }

  async function resolveZonaShared(id) {
    if (!/^[1-9]\d{0,9}$/.test(id)) return null;
    const projects = zonaShardOrder(id);
    let lastError;
    for (let index = 0; index < projects.length; index += 1) {
      const project = projects[index];
      try {
        const hit = await zonaStorageHit(project, id);
        if (hit) return hit;
        const endpoint = `https://${project}.supabase.co/functions/v1/zona` +
          `?kpId=${encodeURIComponent(id)}&forceFunctionRegion=eu-central-1`;
        const { response, data } = await zonaFetch(endpoint, 12_000);
        const resolved = response.ok ? validSharedZona(data, id) : null;
        if (resolved) return resolved;
        if (response.status === 202) {
          for (let attempt = 0; attempt < 4; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 600 + attempt * 300));
            const late = await zonaStorageHit(project, id, 1800);
            if (late) return late;
          }
        }
        if (response.status !== 404) throw new Error(data?.error || `Zona cache ${response.status}`);
      } catch (error) {
        lastError = error;
      }
      // A second project is disaster recovery. Do not walk the whole ring and
      // create multiple cold fills when the upstream itself is unavailable.
      if (index >= 1) break;
    }
    throw lastError || new Error("Zona shared cache unavailable");
  }

  async function resolveOpravar(playerUrl, pageUrl) {
    const query = new URLSearchParams({ url: playerUrl });
    if (pageUrl) query.set("pageUrl", pageUrl);
    return resolverJson(`/resolve-opravar?${query}`, { retries: 1, timeoutMs: 20000 });
  }

  async function resolveOpravarVideo(playerUrl, videoId, base) {
    const query = new URLSearchParams({ url: playerUrl, videoId: String(videoId) });
    if (base) query.set("base", base); // the live (rotating) host the initial resolve found
    return resolverJson(`/resolve-opravar?${query}`, { retries: 1, timeoutMs: 20000 });
  }

  async function searchNewdeaf(query) {
    const normalizedQuery = compact(query);
    const cacheKey = normalizedQuery.toLowerCase().replace(/ё/g, "е");
    const cached = cacheGet(ND_SEARCH_CACHE_NS, cacheKey);
    if (Array.isArray(cached) && cached.length) return cached;

    const mirrors = dailyMirrorCandidates();
    return new Promise((resolve, reject) => {
      let settled = false;
      let finished = 0;
      let lastError = null;
      const timers = [];

      const finish = (candidates) => {
        if (settled) return;
        settled = true;
        timers.forEach((timer) => clearTimeout(timer));
        // Never persist an empty result. "No matches" and "the browser privacy
        // layer swallowed the response" are indistinguishable at the cache
        // boundary, and pinning either one caused browser-specific false misses.
        if (candidates.length) cacheSet(ND_SEARCH_CACHE_NS, cacheKey, candidates, TTL.ndsearch);
        resolve(candidates);
      };
      const fail = (error, mirror) => {
        lastError = error;
        finished += 1;
        log("newdeaf-warn", "mirror failed", { mirror, message: error.message });
        if (!settled && finished === mirrors.length) {
          settled = true;
          reject(lastError || new Error("Newdeaf search unavailable"));
        }
      };

      mirrors.forEach((mirror, index) => {
        // Usually only today's mirror is touched. Adjacent mirrors start only
        // when the previous probe is slow/blocked, avoiding a long serial wait
        // on browsers whose privacy layer leaves cross-site fetch pending.
        const timer = setTimeout(async () => {
          if (settled) return;
          const searchUrl = `${mirror}/index.php?do=search&subaction=search&story=${encodeURIComponent(normalizedQuery)}`;
          try {
            const html = await fetchThirdPartyText(searchUrl, {
              preferSandbox: false,
              label: "newdeaf-search",
              timeoutMs: 7000,
              sandboxTimeoutMs: 9000,
            });
            if (!isNewdeafSearchDocument(html)) throw new Error("Newdeaf returned an invalid search document");
            finish(parseNewdeafSearch(html, searchUrl));
          } catch (error) {
            fail(error, mirror);
          }
        }, index * 1400);
        timers.push(timer);
      });
    });
  }

  async function searchLiftw(query) {
    const normalizedQuery = compact(query).slice(0, 120);
    if (!normalizedQuery) return [];
    const cacheKey = normalizedQuery.toLowerCase().replace(/ё/g, "е");
    const cached = cacheGet(LIFTW_SEARCH_CACHE_NS, cacheKey);
    if (Array.isArray(cached)) return cached;

    // The relay talks to LiftW on our behalf, so LiftW sees the shard rather
    // than the viewer — the same thing the opaque sandbox used to buy us.
    const payload = await liftwRelay({ mode: "search", q: normalizedQuery }, normalizedQuery);
    const results = normalizeLiftwSearchPayload(payload);
    cacheSet(LIFTW_SEARCH_CACHE_NS, cacheKey, results, TTL.liftwsearch);
    return results;
  }

  function normalizeLiftwSearchPayload(payload) {
    const items = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.items)
        ? payload.items
        : Array.isArray(payload?.data)
          ? payload.data
          : Array.isArray(payload?.results)
            ? payload.results
            : null;
    if (!items) throw new Error("LiftW вернул неизвестный формат поиска");
    return items.slice(0, 30).map(normalizeLiftwItem).filter(Boolean);
  }

  function normalizeLiftwItem(item) {
    const id = positiveInt(item?.id);
    const title = compact(item?.name || item?.origin_name).slice(0, 180);
    if (!id || !title) return null;
    const type = positiveInt(item?.type);
    const typeInfo = liftwTypeInfo(type);
    const yearValue = positiveInt(item?.year);
    const maxYear = new Date().getFullYear() + 2;
    const ratingNumber = (value) => {
      const number = Number(value);
      return Number.isFinite(number) && number > 0 && number <= 10 ? number : null;
    };
    return {
      id: String(id),
      title,
      originalTitle: compact(item?.origin_name).slice(0, 180),
      year: yearValue >= 1880 && yearValue <= maxYear ? yearValue : null,
      poster: liftwPosterUrl(item?.poster),
      quality: compact(item?.quality).slice(0, 16),
      serialStatus: compact(item?.serial_status).slice(0, 48),
      rating: {
        kp: ratingNumber(item?.kp_rating),
        imdb: ratingNumber(item?.imdb_rating),
      },
      type: typeInfo.type,
      typeLabel: typeInfo.label,
      isSeries: typeInfo.isSeries,
    };
  }

  function liftwTypeInfo(value) {
    return ({
      1: { type: 1, label: "фильм", isSeries: false },
      2: { type: 2, label: "мультфильм", isSeries: false },
      3: { type: 3, label: "сериал", isSeries: true },
      4: { type: 4, label: "ТВ-шоу", isSeries: true },
      5: { type: 5, label: "мультсериал", isSeries: true },
      6: { type: 6, label: "аниме-фильм", isSeries: false },
      7: { type: 7, label: "аниме-сериал", isSeries: true },
    })[Number(value)] || { type: null, label: "тайтл", isSeries: false };
  }

  function liftwPosterUrl(value) {
    try {
      const url = new URL(String(value || ""));
      return url.protocol === "https:" && url.hostname === "img.niteface.ws" ? url.href : "";
    } catch {
      return "";
    }
  }

  // =====================================================================
  // LiftW playback.
  //
  // The embed is the same player-venom `makePlayer({...})` family Zenith uses,
  // so parseZenithEmbed/normalizeSerialSeasons read it verbatim and the entire
  // serial + Shaka stack below is reused rather than duplicated.
  //
  // Privacy: both the control plane and media plane run through opaque browser
  // sandboxes and fail closed. The CDN still talks directly to the viewer's IP,
  // but receives Origin: null and no referrer instead of alphy.tv. A persistent
  // media sandbox transfers ArrayBuffers to Shaka without involving our backend.
  //
  // Latency: one /info + one embed fetch carry EVERY season/episode with signed
  // CDN URLs valid ~10 days. A whole series therefore costs two requests, and
  // switching episodes costs zero.
  // =====================================================================
  function liftwTarget(id, selection = {}) {
    const target = { kind: "lift", liftId: String(positiveInt(id) || "") };
    const season = positiveInt(selection.season);
    const episode = positiveInt(selection.episode);
    if (season) target.season = season;
    if (episode) target.episode = episode;
    return target;
  }

  function liftwListItem(item, details = {}) {
    const target = liftwTarget(item.id);
    return {
      id: crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
      key: keyFor(target),
      title: details.title || item.title || `LiftW ${item.id}`,
      year: details.year || item.year || "",
      poster: details.poster || item.poster || "",
      description: details.description || "",
      isSeries: !!(details.isSeries ?? item.isSeries),
      movieLength: details.movieLength || null,
      rating: details.rating || item.rating || {},
      target,
      cachedAt: new Date().toISOString(),
    };
  }

  function warmLiftwConnections() {
    // Preconnects must live in the opaque document too. A top-level preconnect
    // is not safely reusable by a null-origin CORS request and may itself expose
    // alphy.tv while warming the connection.
    liftwMediaBroker();
  }

  const LIFTW_OPAQUE_SCHEME = "alphy-liftw:";

  function isLiftwMediaUrl(value) {
    try {
      const url = new URL(String(value || ""));
      return url.protocol === "https:" &&
        url.hostname.endsWith(".interkh.com") &&
        url.hostname.length > ".interkh.com".length;
    } catch {
      return false;
    }
  }

  function liftwOpaqueUri(value) {
    if (!isLiftwMediaUrl(value)) throw new Error("LiftW: blocked media URL");
    return `${LIFTW_OPAQUE_SCHEME}${encodeURIComponent(String(value))}`;
  }

  function liftwUriFromOpaque(value) {
    const raw = String(value || "");
    if (!raw.startsWith(LIFTW_OPAQUE_SCHEME)) throw new Error("LiftW: invalid opaque URI");
    const decoded = decodeURIComponent(raw.slice(LIFTW_OPAQUE_SCHEME.length));
    if (!isLiftwMediaUrl(decoded)) throw new Error("LiftW: blocked opaque media URL");
    return decoded;
  }

  function liftwMediaBroker() {
    if (liftwMediaBridge) return liftwMediaBridge;

    const iframe = document.createElement("iframe");
    iframe.sandbox = "allow-scripts";
    iframe.referrerPolicy = "no-referrer";
    iframe.setAttribute("aria-hidden", "true");
    iframe.style.cssText = "position:fixed;width:1px;height:1px;left:-9999px;top:-9999px;border:0;pointer-events:none";

    const pending = new Map();
    let sequence = 0;
    let readyResolve;
    let readyReject;
    const ready = new Promise((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    const readyTimer = setTimeout(() => readyReject(new Error("LiftW media sandbox timeout")), 8000);
    // Warming the broker does not await this, and a sandbox that never reports
    // ready would otherwise surface as an unhandled rejection. Callers that do
    // await it still see the failure; this only silences the floating copy.
    ready.catch(() => {
      // A slow/blocked first iframe must not poison every later attempt in
      // this tab. The next user action may create a fresh broker.
      if (liftwMediaBridge?.iframe === iframe) liftwMediaBridge = null;
      clearTimeout(readyTimer);
      window.removeEventListener("message", onMessage);
      iframe.remove();
      for (const id of pending.keys()) finish(id, new Error("LiftW media sandbox unavailable"));
    });

    const finish = (id, error, value) => {
      const job = pending.get(id);
      if (!job) return;
      pending.delete(id);
      clearTimeout(job.timer);
      if (error) job.reject(error);
      else job.resolve(value);
    };

    const onMessage = (event) => {
      if (event.source !== iframe.contentWindow || event.origin !== "null") return;
      const data = event.data || {};
      if (!data.alphyLiftwMedia) return;
      if (data.ready) {
        clearTimeout(readyTimer);
        if (data.requestOrigin !== "null" || data.documentReferrer) {
          readyReject(new Error("LiftW media sandbox privacy check failed"));
        } else {
          readyResolve();
        }
        return;
      }
      const job = pending.get(data.id);
      if (!job) return;
      if (data.phase === "headers") {
        job.headers = data.headers || {};
        job.status = Number(data.status) || 0;
        job.responseUrl = data.responseUrl || job.url;
        try { job.headersReceived(job.headers); } catch { /* Shaka callback is optional */ }
        return;
      }
      if (data.phase === "progress") {
        const bytes = Math.max(0, Number(data.bytes) || 0);
        job.bytesReported += bytes;
        try {
          job.progressUpdated(
            Math.max(1, Number(data.elapsedMs) || 1),
            bytes,
            Math.max(0, Number(data.remaining) || 0),
          );
        } catch { /* optional */ }
        return;
      }
      if (!data.ok) {
        finish(data.id, new Error(data.error || `LiftW media fetch ${data.status || "failed"}`));
        return;
      }
      const bytes = data.buffer?.byteLength || 0;
      if (bytes > job.bytesReported) {
        try {
          job.progressUpdated(Date.now() - job.startedAt, bytes - job.bytesReported, 0);
        } catch { /* optional */ }
      }
      finish(data.id, null, {
        uri: data.responseUrl || job.responseUrl || job.url,
        originalUri: job.url,
        data: data.buffer,
        status: Number(data.status) || job.status || 200,
        headers: data.headers || job.headers || {},
        timeMs: Date.now() - job.startedAt,
        fromCache: false,
      });
    };
    window.addEventListener("message", onMessage);

    const request = (url, requestConfig = {}, progressUpdated = () => {}, headersReceived = () => {}) => {
      if (!isLiftwMediaUrl(url)) {
        return { promise: Promise.reject(new Error("LiftW: blocked media URL")), abort: () => Promise.resolve() };
      }
      const id = `liftw-${Date.now()}-${sequence += 1}`;
      let settled = false;
      let rejectJob = () => {};
      const promise = new Promise((resolve, reject) => {
        rejectJob = reject;
        const timer = setTimeout(() => {
          iframe.contentWindow?.postMessage({ alphyLiftwMedia: true, cancel: true, id }, "*");
          finish(id, new Error(`LiftW media timeout for ${url}`));
        }, 60000);
        pending.set(id, {
          url,
          resolve: (value) => { settled = true; resolve(value); },
          reject: (error) => { settled = true; reject(error); },
          timer,
          startedAt: Date.now(),
          progressUpdated,
          headersReceived,
          headers: {},
          status: 0,
          responseUrl: url,
          bytesReported: 0,
        });
        ready.then(() => {
          if (!pending.has(id)) return;
          const range = Object.entries(requestConfig.headers || {})
            .find(([name]) => name.toLowerCase() === "range")?.[1] || "";
          iframe.contentWindow?.postMessage({ alphyLiftwMedia: true, id, url, range }, "*");
        }).catch((error) => finish(id, error));
      });
      return {
        promise,
        abort: () => {
          if (settled || !pending.has(id)) return Promise.resolve();
          iframe.contentWindow?.postMessage({ alphyLiftwMedia: true, cancel: true, id }, "*");
          finish(id, new Error("LiftW media request aborted"));
          // Keep a direct reject reference only for the rare case where the job
          // vanished between the checks above.
          if (!settled) rejectJob(new Error("LiftW media request aborted"));
          return Promise.resolve();
        },
      };
    };

    const preconnects = LIFTW_CDN_ORIGINS
      .map((origin) => `<link rel="preconnect" href="${origin}" crossorigin>`)
      .join("");
    iframe.srcdoc = `<!doctype html><meta charset="utf-8">${preconnects}<script>
const controllers = new Map();
const allowed = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.endsWith('.interkh.com') && url.hostname.length > 12;
  } catch { return false; }
};
addEventListener('message', async (event) => {
  const data = event.data || {};
  if (event.source !== parent || !data.alphyLiftwMedia) return;
  if (data.cancel) { controllers.get(data.id)?.abort(); return; }
  if (!allowed(data.url)) return;
  const controller = new AbortController();
  controllers.set(data.id, controller);
  try {
    const headers = data.range ? { Range: data.range } : {};
    const response = await fetch(data.url, {
      cache: 'default', credentials: 'omit', mode: 'cors', referrerPolicy: 'no-referrer',
      headers, signal: controller.signal,
    });
    if (!allowed(response.url)) throw new Error('Blocked media redirect');
    const responseHeaders = {};
    response.headers.forEach((value, name) => { responseHeaders[name.toLowerCase()] = value; });
    parent.postMessage({
      alphyLiftwMedia: true, id: data.id, phase: 'headers', status: response.status,
      responseUrl: response.url, headers: responseHeaders,
    }, '*');
    if (!response.ok) throw new Error('Fetch ' + response.status);
    const declaredSize = Number(response.headers.get('content-length')) || 0;
    let buffer;
    if (response.body && typeof response.body.getReader === 'function') {
      const reader = response.body.getReader();
      const chunks = [];
      let received = 0;
      let reported = 0;
      let reportedAt = performance.now();
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        chunks.push(part.value);
        received += part.value.byteLength;
        const now = performance.now();
        if (now - reportedAt >= 250) {
          parent.postMessage({
            alphyLiftwMedia: true, id: data.id, phase: 'progress',
            elapsedMs: now - reportedAt, bytes: received - reported,
            remaining: Math.max(0, declaredSize - received),
          }, '*');
          reported = received;
          reportedAt = now;
        }
      }
      if (received > reported) {
        parent.postMessage({
          alphyLiftwMedia: true, id: data.id, phase: 'progress',
          elapsedMs: performance.now() - reportedAt, bytes: received - reported,
          remaining: 0,
        }, '*');
      }
      const joined = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
      buffer = joined.buffer;
    } else {
      buffer = await response.arrayBuffer();
      parent.postMessage({
        alphyLiftwMedia: true, id: data.id, phase: 'progress',
        elapsedMs: 1, bytes: buffer.byteLength, remaining: 0,
      }, '*');
    }
    parent.postMessage({
      alphyLiftwMedia: true, id: data.id, ok: true, status: response.status,
      responseUrl: response.url, headers: responseHeaders, buffer,
    }, '*', [buffer]);
  } catch (error) {
    parent.postMessage({
      alphyLiftwMedia: true, id: data.id, ok: false,
      error: String(error && error.message || error),
    }, '*');
  } finally { controllers.delete(data.id); }
});
parent.postMessage({
  alphyLiftwMedia: true, ready: true,
  requestOrigin: location.origin, documentReferrer: document.referrer,
}, '*');
<\/script>`;
    document.body.appendChild(iframe);

    liftwMediaBridge = { ready, request, iframe };
    return liftwMediaBridge;
  }

  function installLiftwOpaqueNetworking(player) {
    if (!liftwOpaqueSchemeRegistered) {
      shaka.net.NetworkingEngine.registerScheme(
        "alphy-liftw",
        (uri, request, requestType, progressUpdated, headersReceived) => {
          const url = liftwUriFromOpaque(uri);
          const operation = liftwMediaBroker().request(url, request, progressUpdated, headersReceived);
          return new shaka.util.AbortableOperation(operation.promise, operation.abort);
        },
        shaka.net.NetworkingEngine.PluginPriority.APPLICATION,
        true,
      );
      liftwOpaqueSchemeRegistered = true;
    }
    player.getNetworkingEngine().registerRequestFilter((_type, request) => {
      request.uris = request.uris.map((uri) => (
        isLiftwMediaUrl(uri) ? liftwOpaqueUri(uri) : uri
      ));
    });
  }

  async function fetchLiftwMediaText(url) {
    if (liftwManifestFetcher) return liftwManifestFetcher(url);
    const operation = liftwMediaBroker().request(url);
    const response = await operation.promise;
    return new TextDecoder().decode(response.data);
  }

  // memory-free by design: the parse is small (sources + seasons + meta) and the
  // localStorage TTL cache already survives reloads, which is what actually pays.
  async function resolveLiftwTitle(id, { force = false } = {}) {
    const safeId = positiveInt(id);
    if (!safeId) throw new Error("LiftW: неверный id");
    const key = String(safeId);
    if (force) {
      try { localStorage.removeItem(`${CACHE_PREFIX}${LIFTW_TITLE_CACHE_NS}:${key}`); } catch { /* ignore */ }
    } else {
      const cached = cacheGet(LIFTW_TITLE_CACHE_NS, key);
      if (cached?.sources || cached?.playlist?.seasons?.length) return cached;
      const inflight = liftwTitleInflight.get(key);
      if (inflight) return inflight;
    }
    const pending = fetchLiftwTitle(key)
      .then((parsed) => {
        // A relay copy's media URLs belong to the relay; keeping it would make
        // every open for five hours start with a 410.
        if (!parsed.viaRelay) cacheSet(LIFTW_TITLE_CACHE_NS, key, parsed, TTL.liftwtitle);
        return parsed;
      })
      .finally(() => liftwTitleInflight.delete(key));
    liftwTitleInflight.set(key, pending);
    return pending;
  }

  // Hover warming. Costs a speculative token and stays silent on failure — a
  // cold click still resolves normally, it just pays the two round trips itself.
  // Returns the in-flight parse when one was actually started, so a caller can
  // hang cosmetic work (the card's runtime) off it. Null means "not warmed" —
  // either already cached, already running, or over the speculative budget.
  function prefetchLiftwTitle(id) {
    const key = String(positiveInt(id) || "");
    if (!key || liftwTitleInflight.has(key) || cacheGet(LIFTW_TITLE_CACHE_NS, key)) return null;
    if (!claimSpeculativeIntent()) return null;
    warmLiftwConnections();
    const pending = resolveLiftwTitle(key);
    pending.catch((error) => log("liftw-prefetch-warn", error.message));
    // Settle the AV1-vs-VP9 question here too, so the click reads a cached
    // verdict instead of paying for a manifest. A series resolves its ladders per
    // episode, so only a movie can be answered this early.
    pending.then((parsed) => {
      if (!parsed?.playlist?.seasons?.length) return pickLiftwLadder(parsed?.sources);
    }).catch(() => {});
    return pending;
  }

  // Start one backup only when the primary is slow or fails. Fast requests
  // keep their original cost; the losing fetch/iframe is cancelled.
  function hedgedRequest(primary, backup, delayMs = 1800) {
    return new Promise((resolve, reject) => {
      const controllers = [new AbortController(), new AbortController()];
      let done = false, startedBackup = false, failures = 0, lastError;
      const finish = (value, index) => {
        if (done) return;
        done = true; clearTimeout(timer); controllers[1 - index].abort(); resolve(value);
      };
      const failed = (error, index) => {
        if (done) return;
        failures += 1; lastError = error;
        if (index === 0) startBackup();
        if (failures === 2) { done = true; clearTimeout(timer); reject(lastError); }
      };
      const startBackup = () => {
        if (done || startedBackup) return;
        startedBackup = true;
        Promise.resolve().then(() => backup(controllers[1].signal)).then((v) => finish(v, 1), (e) => failed(e, 1));
      };
      const timer = setTimeout(startBackup, delayMs);
      Promise.resolve().then(() => primary(controllers[0].signal)).then((v) => finish(v, 0), (e) => failed(e, 0));
    });
  }

  async function liftwRequest(operation, signal, timeoutMs) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(abort, timeoutMs);
    try { return await operation(controller.signal); }
    finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  }

  // Same ring shape the Letterboxd lookup uses: a stable starting point per key
  // so a repeated query keeps hitting the same (warm) shard, with the rest as
  // failover. A shard that errors cools off rather than being retried per call.
  const liftwCooldown = new Map();
  function liftwEndpointOrder(key) {
    let hash = 0;
    const text = String(key || "");
    for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
    const start = hash % LIFTW_ENDPOINTS.length;
    return LIFTW_ENDPOINTS.map((_, index) =>
      LIFTW_ENDPOINTS[(start + index) % LIFTW_ENDPOINTS.length]);
  }

  async function liftwRelay(params, key) {
    const now = Date.now();
    const order = liftwEndpointOrder(key);
    const ready = order.filter((endpoint) => (liftwCooldown.get(endpoint) || 0) <= now);
    const endpoints = ready.length ? ready : order;
    const ask = async (endpoint, signal) => {
      const url = new URL(endpoint);
      for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
      try {
        const payload = await liftwRequest(async (requestSignal) => {
          const response = await fetch(url.href, { signal: requestSignal,
            ...(params.mode === "info" ? { cache: "no-cache" } : {}) });
          if (!response.ok) throw new Error(`liftw relay ${response.status}`);
          const data = await response.json();
          if (data?.error) throw new Error(String(data.error));
          return data;
        }, signal, 9000);
        liftwCooldown.delete(endpoint);
        return payload;
      } catch (error) {
        if (!signal?.aborted) {
          liftwCooldown.set(endpoint, Date.now() + LIFTW_COOLDOWN_MS);
          log("liftw-relay-warn", `${new URL(endpoint).hostname}: ${error.message}`);
        }
        throw error;
      }
    };
    if (endpoints.length === 1) return ask(endpoints[0]);
    return hedgedRequest((signal) => ask(endpoints[0], signal), async (signal) => {
      let lastError;
      for (const endpoint of endpoints.slice(1)) {
        if (signal.aborted) throw new Error("LiftW request cancelled");
        try { return await ask(endpoint, signal); } catch (error) { lastError = error; }
      }
      throw lastError || new Error("LiftW недоступен");
    });
  }

  async function fetchLiftwTitle(id) {
    const info = await liftwRelay({ mode: "info", id: String(id) }, `info:${id}`);
    const candidates = liftwEmbedCandidates(info?.iframe_uri);
    if (!candidates.length) throw new Error("LiftW не выдал ссылку на плеер");

    const { html, viaRelay } = await fetchLiftwEmbed(candidates);
    const parsed = parseZenithEmbed(html);
    const seasons = parsed.playlist?.seasons || [];
    if (!seasons.length && !bestLiftwSource(parsed.sources)) {
      throw new Error("LiftW не отдал источники для этого тайтла");
    }
    return {
      id: String(id),
      sources: parsed.sources,
      audioNames: parsed.meta.audioNames || [],
      blockedAudioNames: parsed.meta.blockedAudioNames || [],
      textTracks: liftwTextTracks(html),
      meta: liftwMeta(info),
      playlist: { current: parsed.playlist?.current || null, seasons },
      viaRelay,
    };
  }

  // /info hands back a signed embed URL on embed.liftw.ws. That host is blocked
  // in Russia, so the same path is tried on lift3.ws first — same backend, same
  // id space, same player — and the original is kept as the fallback for
  // addresses lift3.ws turns away. The signature rides along; the bare path is
  // tried too, because it answers 200 on both hosts again (it once did not, and
  // the note saying so is why this used to refuse to synthesise it).
  function liftwEmbedCandidates(value) {
    let source;
    try {
      source = new URL(String(value || ""));
    } catch {
      return [];
    }
    if (source.protocol !== "https:") return [];
    if (source.hostname.toLowerCase() !== "embed.liftw.ws") return [];
    if (!/^\/embed\/movie\/\d+$/.test(source.pathname)) return [];

    // lift3.ws direct first: it reaches the browser in Russia and keeps the
    // video path client-only. embed.liftw.ws is NOT tried directly — it is the
    // host that is blocked, so a direct attempt could only ever burn a timeout.
    // The relay is the fallback instead, and it tries both hosts server-side.
    const out = [];
    const direct = new URL(source.href);
    direct.hostname = "lift3.ws";
    out.push(direct.href);
    if (source.search) {
      const bare = new URL(direct.href);
      bare.search = "";
      out.push(bare.href);
    }
    out.push(liftwRelayEmbedUrl(source));
    return out.filter(Boolean);
  }

  // The relay rebuilds the embed URL from the id plus the signature parts it
  // recognises, so this passes those parts rather than a whole URL.
  function liftwRelayEmbedUrl(source) {
    const id = (source.pathname.match(/(\d+)/) || [])[1];
    if (!id) return "";
    const url = new URL(liftwEndpointOrder(`embed:${id}`)[0]);
    url.searchParams.set("mode", "embed");
    url.searchParams.set("id", id);
    for (const name of ["host", "imp2", "imp3", "t2", "ht", "season", "episode"]) {
      const value = source.searchParams.get(name);
      if (value) url.searchParams.set(name, value);
    }
    return url.href;
  }

  // The player page is minted for whoever fetches it: its media URLs carry a
  // hash of that address and user agent (hi/hu), and the CDN answers 410 to
  // anyone else. Measured on one title: the browser's own copy served the init
  // segment 200, the relay's copy 410. So the relay is never raced against the
  // direct fetch — winning that race after 1.8 s made a slow first connection
  // end in a page that could not play, cached for five hours. It is asked only
  // once the direct attempts have failed, for the playlist and metadata, and
  // the caller is told the media will not play from it.
  async function fetchLiftwEmbed(candidates) {
    const direct = candidates.filter((url) => !LIFTW_ENDPOINTS.some((endpoint) => url.startsWith(endpoint)));
    const relays = candidates.filter((url) => LIFTW_ENDPOINTS.some((endpoint) => url.startsWith(endpoint)));
    const hasPlayer = (html) => /makePlayer\s*\(/.test(String(html || ""));
    let lastError;
    for (const url of direct) {
      try {
        const html = await fetchThirdPartyText(url, { preferSandbox: true, directFallback: false,
          label: "liftw-embed", timeoutMs: 9000, sandboxTimeoutMs: 9000 });
        if (hasPlayer(html)) return { html, viaRelay: false };
        throw new Error("ответ без makePlayer");
      } catch (error) {
        lastError = error;
        log("liftw-embed-warn", `${new URL(url).hostname}: ${error.message}`);
        // The bare path is the same host: after a timeout it would only wait again.
        if (/timeout/i.test(error.message)) break;
      }
    }
    for (const url of relays) {
      try {
        const html = await liftwRequest(async (signal) => {
          const response = await fetch(url, { signal });
          if (!response.ok) throw new Error(`LiftW embed ${response.status}`);
          return response.text();
        }, undefined, 12000);
        if (hasPlayer(html)) return { html, viaRelay: true };
        throw new Error("ответ без makePlayer");
      } catch (error) {
        lastError = error;
        log("liftw-embed-warn", `${new URL(url).hostname}: ${error.message}`);
      }
    }
    throw lastError || new Error("LiftW не отдал плеер");
  }

  // A movie's `cc` is a JSON array of {url,name} sitting unquoted in the same
  // makePlayer object; the .vtt files are on the CDN behind the video's own
  // signature. Series pages have no top-level `cc:` — every episode carries its
  // own inside the playlist JSON, which normalizeSerialSeasons picks up instead.
  function liftwTextTracks(html) {
    const match = /\bcc\s*:\s*\[/.exec(String(html || ""));
    if (!match) return [];
    const arrayText = balancedJsContainer(String(html), match.index + match[0].length - 1, "[", "]");
    if (!arrayText) return [];
    try { return embedTextTracks({ cc: JSON.parse(arrayText) }); }
    catch { return []; }
  }

  function liftwSubtitleLanguage(label) {
    const text = String(label || "").toLowerCase();
    if (/укр|ukr/.test(text)) return "uk";
    if (/рус|rus/.test(text)) return "ru";
    if (/eng|англ/.test(text)) return "en";
    return "und";
  }

  // /info carries a full Kinopoisk-grade record, so a LiftW watch page needs no
  // kinopoisk key and no second metadata round trip.
  function liftwMeta(info) {
    const details = info?.info && typeof info.info === "object" ? info.info : {};
    const typeInfo = liftwTypeInfo(info?.type);
    const ratingNumber = (value) => {
      const number = Number(value);
      return Number.isFinite(number) && number > 0 && number <= 10 ? number : null;
    };
    const list = (value, limit) => (Array.isArray(value) ? value : [])
      .map((entry) => compact(entry).slice(0, 60))
      .filter(Boolean)
      .slice(0, limit);
    const minutes = liftwRuntimeMinutes(details.time);
    return {
      title: compact(info?.name || info?.origin_name).slice(0, 180),
      originalTitle: compact(info?.origin_name).slice(0, 180),
      year: positiveInt(info?.year) || "",
      poster: liftwPosterUrl(info?.poster),
      description: compact(details.description).slice(0, 2000),
      isSeries: typeInfo.isSeries,
      movieLength: minutes,
      ageRating: positiveInt(details.age),
      ratingMpaa: compact(details.rate_mpaa).slice(0, 8).toLowerCase() || null,
      genres: list(details.genre, 6),
      countries: list(details.country, 4),
      rating: {
        kp: ratingNumber(info?.kp_rating),
        imdb: ratingNumber(info?.imdb_rating),
      },
      people: {
        directors: list(details.director, 3).map((name) => ({ name })),
        cast: list(details.actors, 8).map((name) => ({ name })),
      },
      kpId: String(positiveInt(details.id) || ""),
    };
  }

  // `info.time` comes in four shapes: "121 мин. / 02:01", "2 ч 25 мин", "30 мин"
  // and, for a series, "55 мин. серия (5160 мин. всего)" — where the leading
  // number is the per-episode runtime we want. Reading the first "N мин" alone
  // turned "2 ч 25 мин" into a 25-minute feature, so the hours are matched first.
  function liftwRuntimeMinutes(value) {
    const text = String(value || "");
    const hours = /(\d+)\s*ч(?![а-яё])/i.exec(text);
    if (hours) {
      const rest = positiveInt(/(\d+)\s*мин/i.exec(text.slice(hours.index + hours[0].length))?.[1]) || 0;
      return Number(hours[1]) * 60 + rest;
    }
    return positiveInt(/(\d+)\s*мин/i.exec(text)?.[1]);
  }

  // =====================================================================
  // Letterboxd rating
  //
  // One hop to our own Supabase Edge function, which resolves
  // letterboxd.com/imdb/<id> and reads the score out of the page. Exact match on
  // an id we already hold, never on a title. Every film is asked for once per
  // browser and then answered from localStorage.
  // =====================================================================
  const letterboxdCooldown = new Map();
  const letterboxdInflight = new Map();
  const letterboxdAsked = new Map();

  // Each project keeps its own table of ratings, so a film's project must not
  // move when the ring grows. The first four split ids by hash % 4; a project
  // added later takes only the ids with hash % n === n - 1 — its fair share —
  // and every other film stays on the table that already holds its rating.
  // scripts/bake-curated-letterboxd.mjs repeats this; a test keeps them equal.
  function letterboxdShardIndex(hash, count) {
    let index = hash % Math.min(count, 4);
    for (let n = 5; n <= count; n += 1) if (hash % n === n - 1) index = n - 1;
    return index;
  }

  // Deterministic first pick, then the rest of the ring. Keeping a film pinned
  // to one project is what makes the function's own Cache-Control worth having.
  function letterboxdEndpointOrder(imdbId) {
    let hash = 0;
    for (const char of String(imdbId)) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
    const start = letterboxdShardIndex(hash, LETTERBOXD_ENDPOINTS.length);
    return LETTERBOXD_ENDPOINTS.map((_, index) =>
      LETTERBOXD_ENDPOINTS[(start + index) % LETTERBOXD_ENDPOINTS.length]);
  }

  async function letterboxdRating(imdbId) {
    const id = String(imdbId || "").trim();
    if (!/^tt\d{6,10}$/.test(id)) return null;
    const cached = cacheGet(LETTERBOXD_CACHE_NS, id);
    if (cached) return cached.r > 0 ? cached : null;
    return (await letterboxdFilm(id)).rating;
  }

  // The watch page wants the score and the reviews, and one film page carries
  // both — so it asks once, with reviews, and both caches fill from that single
  // answer. Asking for each separately cost a second call on every film opened.
  function letterboxdFilm(id) {
    const inflight = letterboxdInflight.get(id);
    if (inflight) return inflight;
    const pending = fetchLetterboxdFilm(id).finally(() => letterboxdInflight.delete(id));
    letterboxdInflight.set(id, pending);
    return pending;
  }

  // Resolves to { rating, reviews, answeredBy }. `reviews` stays undefined when
  // the shard that answered is a build that does not know about them.
  async function fetchLetterboxdFilm(id) {
    const now = Date.now();
    for (const endpoint of letterboxdEndpointOrder(id)) {
      if ((letterboxdCooldown.get(endpoint) || 0) > now) continue;
      let payload = null;
      try {
        const controller = new AbortController();
        // Long enough for a film nobody has opened yet: it is scraped during
        // this call, and the scrape alone is about two seconds.
        const timer = setTimeout(() => controller.abort(), 12000);
        const response = await fetch(`${endpoint}?imdb=${encodeURIComponent(id)}&reviews=1`, {
          signal: controller.signal,
          referrerPolicy: "no-referrer",
        });
        clearTimeout(timer);
        if (!response.ok) throw new Error(`http ${response.status}`);
        payload = await response.json();
      } catch (error) {
        // One project being paused or over quota must not make every later
        // caller wait out the same timeout, so it sits out and the ring moves on.
        letterboxdCooldown.set(endpoint, now + LETTERBOXD_COOLDOWN_MS);
        log("letterboxd-warn", { endpoint, message: error.message });
        continue;
      }
      // The function could reach neither its table nor Letterboxd. That is an
      // operational miss, not a verdict about the film: another shard may
      // already have the row, and this result must never enter the 7-day cache.
      if (payload?.unreachable === true) continue;
      const score = Number(payload?.r);
      const found = payload?.found && Number.isFinite(score) && score > 0 && score <= 5;
      const rating = found
        ? { r: score, n: positiveInt(payload.n), slug: compact(payload.slug).slice(0, 120) }
        : null;
      cacheSet(LETTERBOXD_CACHE_NS, id, rating || { r: 0 }, found ? TTL.letterboxd : TTL.letterboxdmiss);
      const reviews = Array.isArray(payload?.reviews) ? storeLetterboxdReviews(id, payload.reviews) : undefined;
      return { rating, reviews, answeredBy: endpoint };
    }
    return { rating: null, reviews: undefined, answeredBy: "" };
  }

  // A grid asks once per shard rather than once per card. The server answers
  // these from its table only and never reaches out to Letterboxd, so a page of
  // covers can never turn into a burst of scraping — unknown films simply stay
  // blank until someone opens one.
  //
  // Every grid on the page feeds one queue that is flushed a beat after the first
  // ask. Asking per grid sent a request per row per shard: 32 calls to paint one
  // home page, every visit.
  const letterboxdQueue = new Map();
  let letterboxdFlushTimer = null;

  async function letterboxdBatch(imdbIds) {
    const ids = [...new Set(imdbIds)].filter((id) => /^tt\d{6,10}$/.test(id));
    // A search grid renders twice — once for the race winner, once for the merged
    // result — and the second pass builds fresh card elements. It must therefore
    // wait on the first pass's request rather than skip it, or it would paint
    // from a cache that has not been filled yet.
    const waiting = [];
    for (const id of ids) {
      if (cacheGet(LETTERBOXD_CACHE_NS, id)) continue;
      const asked = letterboxdAsked.get(id);
      if (asked) {
        waiting.push(asked);
        continue;
      }
      // Our table had never looked this film up when we last asked. Asking
      // again on every visit is what kept a home page at thirty-odd calls; the
      // watch page does not read this, so opening the film still fills it in.
      if (cacheGet(LETTERBOXD_UNKNOWN_NS, id)) continue;
      let settle;
      const promise = new Promise((resolve) => { settle = resolve; });
      letterboxdAsked.set(id, promise);
      letterboxdQueue.set(id, settle);
      waiting.push(promise);
    }
    if (letterboxdQueue.size && !letterboxdFlushTimer) {
      letterboxdFlushTimer = setTimeout(flushLetterboxdQueue, LETTERBOXD_BATCH_WINDOW_MS);
    }
    await Promise.all(waiting);
  }

  function flushLetterboxdQueue() {
    letterboxdFlushTimer = null;
    const queued = [...letterboxdQueue];
    letterboxdQueue.clear();
    const byEndpoint = new Map();
    for (const entry of queued) {
      const endpoint = letterboxdEndpointOrder(entry[0])[0];
      if (!byEndpoint.has(endpoint)) byEndpoint.set(endpoint, []);
      byEndpoint.get(endpoint).push(entry);
    }
    // The function reads only the first sixty ids of a call, so a bigger set is
    // split rather than silently cut short.
    for (const [endpoint, entries] of byEndpoint) {
      for (let at = 0; at < entries.length; at += LETTERBOXD_BATCH_MAX) {
        askLetterboxdShard(endpoint, entries.slice(at, at + LETTERBOXD_BATCH_MAX));
      }
    }
  }

  async function askLetterboxdShard(endpoint, entries) {
    const ids = entries.map(([id]) => id);
    try {
      // A cooling shard is not asked, and its films stay askable once it is back.
      if ((letterboxdCooldown.get(endpoint) || 0) > Date.now()) {
        for (const id of ids) letterboxdAsked.delete(id);
        return;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 7000);
      // mode=batch is explicit: a shard can legitimately receive a single id,
      // and the shape of the reply must not depend on how many that happened
      // to be. Inferring it from a comma is what silently broke narrow grids.
      const response = await fetch(`${endpoint}?mode=batch&imdb=${ids.join(",")}`, {
        signal: controller.signal,
        referrerPolicy: "no-referrer",
      });
      clearTimeout(timer);
      if (!response.ok) throw new Error(`http ${response.status}`);
      const payload = await response.json();
      // Shards are deployed independently, so one can be a version behind and
      // still answer in the older single-film shape. Reading both means a
      // stale shard costs its own films, not the whole grid.
      const items = payload?.items || (/^tt\d{6,10}$/.test(String(payload?.imdb || ""))
        ? { [payload.imdb]: payload.found ? { r: payload.r, n: payload.n, slug: payload.slug } : null }
        : {});
      for (const id of ids) {
        // Absent means "not looked up yet", not "no rating". It is remembered
        // apart from the verdicts, for a day, and never stands in for one.
        if (!(id in items)) {
          cacheSet(LETTERBOXD_UNKNOWN_NS, id, 1, TTL.letterboxdunknown);
          continue;
        }
        const hit = items[id];
        const rating = Number(hit?.r);
        const value = hit && Number.isFinite(rating) && rating > 0 && rating <= 5
          ? { r: rating, n: positiveInt(hit.n), slug: compact(hit.slug).slice(0, 120) }
          : null;
        cacheSet(LETTERBOXD_CACHE_NS, id, value || { r: 0 }, value ? TTL.letterboxd : TTL.letterboxdmiss);
      }
    } catch (error) {
      log("letterboxd-batch-warn", { endpoint, message: error.message });
      // A failed request says nothing about the films. The shard sits out a few
      // minutes, and its films may be asked again after that — not in a day.
      letterboxdCooldown.set(endpoint, Date.now() + LETTERBOXD_COOLDOWN_MS);
      for (const id of ids) letterboxdAsked.delete(id);
    } finally {
      for (const [, settle] of entries) settle();
    }
  }

  // =====================================================================
  // Kinopoisk id -> LiftW id
  //
  // LiftW publishes the mapping in one direction only: /info reports the
  // Kinopoisk id in info.id, and there is no lookup that takes one (probed:
  // /kp/<id>, /info?kp_id=, /find?kp= are all 404, and /info/<kp> resolves in
  // LiftW's own id space, silently returning a different film).
  //
  // So the reverse is a search followed by a CONFIRMATION. Candidates are found
  // by title, but one is only ever accepted when its own /info reports exactly
  // the Kinopoisk id we asked for. A title/year match is never enough by itself
  // — that check is the whole reason this is safe to run automatically.
  // =====================================================================
  async function liftwKpIdFor(liftId) {
    const key = String(positiveInt(liftId) || "");
    if (!key) return "";
    const warm = cacheGet(LIFTW_TITLE_CACHE_NS, key);
    if (warm?.meta?.kpId) return String(warm.meta.kpId);
    const cached = cacheGet(LIFTW_KP_OF_CACHE_NS, key);
    if (typeof cached === "string") return cached;
    let kpId = "", failed = false;
    try {
      const info = await liftwRelay({ mode: "info", id: key }, `info:${key}`);
      kpId = String(positiveInt(info?.info?.id) || "");
    } catch { failed = true; }
    cacheSet(LIFTW_KP_OF_CACHE_NS, key, kpId, failed ? 60e3 : kpId ? TTL.liftwkp : TTL.liftwkpmiss);
    return kpId;
  }

  // At most CONFIRM_LIMIT confirmations, cheapest-looking candidate first, and
  // the whole verdict — hit or miss — is cached so a retry never re-runs the
  // fan-out. Cost when it misses: one search plus three small JSON fetches.
  const LIFTW_CONFIRM_LIMIT = 3;

  async function findLiftwByKpId(kpId, hints = {}) {
    const wanted = String(positiveInt(kpId) || "");
    if (!wanted) return "";
    const cached = cacheGet(LIFTW_BY_KP_CACHE_NS, wanted);
    if (typeof cached === "string") return cached;

    const inflight = liftwByKpInflight.get(wanted);
    if (inflight) return inflight;

    const pending = (async () => {
      const queries = [hints.title, hints.originalTitle]
        .map((value) => compact(value))
        .filter((value) => value && !isPlaceholderTitle(value));
      if (!queries.length) return "";

      const seen = new Set();
      const candidates = [];
      for (const query of queries) {
        const hits = await searchLiftw(query).catch(() => []);
        for (const hit of hits) {
          if (seen.has(hit.id)) continue;
          seen.add(hit.id);
          candidates.push(hit);
        }
      }
      const ranked = candidates
        .map((hit) => ({ hit, score: liftwCandidateScore(hit, hints) }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, LIFTW_CONFIRM_LIMIT);

      let found = "";
      for (const entry of ranked) {
        const confirmed = await liftwKpIdFor(entry.hit.id).catch(() => "");
        if (confirmed && confirmed === wanted) {
          found = String(entry.hit.id);
          break;
        }
      }
      cacheSet(LIFTW_BY_KP_CACHE_NS, wanted, found, found ? TTL.liftwkp : TTL.liftwkpmiss);
      return found;
    })().finally(() => liftwByKpInflight.delete(wanted));
    liftwByKpInflight.set(wanted, pending);
    return pending;
  }

  // Ranking only decides *what to confirm first*; it can never admit a wrong
  // title on its own. A mismatched year or format is dropped outright, because
  // confirming it would spend a request that can only fail.
  function liftwCandidateScore(hit, hints = {}) {
    if (hints.isSeries != null && hit.isSeries !== !!hints.isSeries) return 0;
    const year = positiveInt(hints.year);
    if (year && hit.year && Math.abs(hit.year - year) > 1) return 0;
    const norm = (value) => compact(value).toLowerCase().replace(/ё/g, "е").replace(/[^a-zа-я0-9]+/gi, " ").trim();
    const names = [norm(hit.title), norm(hit.originalTitle)].filter(Boolean);
    const wants = [norm(hints.title), norm(hints.originalTitle)].filter(Boolean);
    let score = 1;
    if (names.some((name) => wants.includes(name))) score += 4;
    else if (names.some((name) => wants.some((want) => name.startsWith(want) || want.startsWith(name)))) score += 2;
    if (year && hit.year === year) score += 2;
    return score;
  }

  // Three complete ladders arrive in the same embed: `dasha` is AV1, `dash` is
  // VP9 at the same frame size, `hls` is H.264 capped near 720p. Prefer the
  // cheapest codec the browser can actually decode, and fall back to HLS, which
  // plays anywhere. Whether that AV1 preference actually holds is decided by
  // pickLiftwLadder below — see the bitrate note there.
  function bestLiftwSource(sources) {
    // Tizen often advertises WebM MSE support even when its browser cannot keep
    // AV1/VP9 decoding smooth. LiftW's HLS is H.264 and takes Samsung's reliable
    // hardware path; no other browser has its ladder choice changed.
    if (TIZEN_VIDEO_MODE && sources?.hls) return { url: sources.hls, kind: "hls" };
    if (sources?.dasha && canPlayLiftwCodec('video/webm; codecs="av01.0.08M.08"')) {
      return { url: sources.dasha, kind: "dasha" };
    }
    if (sources?.dash && canPlayLiftwCodec('video/webm; codecs="vp09.00.40.08"')) {
      return { url: sources.dash, kind: "dash" };
    }
    if (sources?.hls) return { url: sources.hls, kind: "hls" };
    if (sources?.dash) return { url: sources.dash, kind: "dash" };
    if (sources?.dasha) return { url: sources.dasha, kind: "dasha" };
    return null;
  }

  // AV1 is roughly 30-50% more efficient than VP9, so a cheaper AV1 rung at the
  // same frame size is normally the better deal. LiftW's AV1 ladders are not
  // normal: measured across 25 films they are bimodal. A healthy one runs
  // 0.07-0.24 bits per pixel per frame; a starved one runs 0.010-0.032 — the
  // same 1920-wide frame at a tenth of the data, which is far past anything a
  // codec can account for (Дюна: AV1 0.36 Mbps against VP9 3.42 Mbps). Nine of
  // the thirteen AV1 ladders sampled were starved, so this is the common case.
  //
  // Worse, a starved ladder has no better rung to climb to: its top IS 0.36
  // Mbps, so a fast connection buys nothing. Falling back to VP9 does not force
  // anyone onto a 12 Mbps stream — ABR still picks by measured bandwidth; it
  // just restores a ceiling worth reaching for.
  //
  // 0.045 sits in the empty gap between the two clusters.
  const LIFTW_AV1_MIN_BPP = 0.045;
  const LIFTW_LADDER_CACHE_NS = "liftwladder.v1";

  async function pickLiftwLadder(sources) {
    const choice = bestLiftwSource(sources);
    // Only worth asking when AV1 was chosen AND there is something to fall back
    // to. Everywhere else the sync answer already is the answer.
    if (choice?.kind !== "dasha" || !sources?.dash) return choice;
    const healthy = await liftwAv1IsHealthy(sources.dasha);
    return healthy ? choice : { url: sources.dash, kind: "dash" };
  }

  // Fail-safe: any parse or network trouble keeps the AV1 ladder, which is what
  // shipped before this check existed. The verdict is cached against the
  // manifest path (the ?t= signature rotates, the path does not), so the hover
  // warm-up pays for it and the click does not.
  async function liftwAv1IsHealthy(manifestUrl) {
    let key = "";
    try { key = new URL(manifestUrl).pathname; } catch { return true; }
    const cached = cacheGet(LIFTW_LADDER_CACHE_NS, key);
    if (typeof cached === "boolean") return cached;
    let healthy = true;
    try {
      const top = topDashRepresentation(await fetchLiftwMediaText(manifestUrl));
      if (top) healthy = top.bandwidth / (top.width * top.height * top.fps) >= LIFTW_AV1_MIN_BPP;
    } catch {
      return true;
    }
    cacheSet(LIFTW_LADDER_CACHE_NS, key, healthy, TTL.liftwtitle);
    return healthy;
  }

  // The largest frame, and within it the fattest rung — that is the ceiling the
  // player would actually be climbing towards.
  function topDashRepresentation(xml) {
    const text = String(xml || "");
    const docFps = /frameRate="([\d/.]+)"/.exec(text)?.[1];
    let best = null;
    for (const tag of text.match(/<Representation[^>]*>/g) || []) {
      // "bandwidth" ends in "width", so an unanchored /width="/ matches it.
      const width = positiveInt(/(?<![a-z])width="(\d+)"/.exec(tag)?.[1]);
      const height = positiveInt(/height="(\d+)"/.exec(tag)?.[1]);
      const bandwidth = positiveInt(/bandwidth="(\d+)"/.exec(tag)?.[1]);
      if (!width || !height || !bandwidth) continue;
      const rate = /frameRate="([\d/.]+)"/.exec(tag)?.[1] || docFps || "24";
      const [num, den] = String(rate).split("/");
      const fps = Number(num) / (Number(den) || 1) || 24;
      const candidate = { width, height, bandwidth, fps };
      if (!best
        || width * height > best.width * best.height
        || (width === best.width && height === best.height && bandwidth > best.bandwidth)) {
        best = candidate;
      }
    }
    return best;
  }

  // Both WebM ladders carry Opus audio only, so a browser that cannot decode
  // Opus in MSE (older Safari) must not be handed DASH at all.
  function canPlayLiftwCodec(videoType) {
    const media = typeof window !== "undefined" ? window.MediaSource : null;
    if (!media?.isTypeSupported) return false;
    try {
      return media.isTypeSupported(videoType) && media.isTypeSupported('audio/webm; codecs="opus"');
    } catch {
      return false;
    }
  }

  async function resolveNewdeafPage(pageUrl) {
    const cached = cacheGet("ndpage", pageUrl);
    if (cached) return cached;
    const inflight = newdeafPageInflight.get(pageUrl);
    if (inflight) return inflight;
    const pending = fetchNewdeafPage(pageUrl).finally(() => newdeafPageInflight.delete(pageUrl));
    newdeafPageInflight.set(pageUrl, pending);
    return pending;
  }

  async function fetchNewdeafPage(pageUrl) {
    const candidates = pageUrlCandidates(pageUrl);
    let parsed = null;
    for (const candidate of candidates) {
      try {
        const html = await fetchThirdPartyText(candidate, { preferSandbox: false, label: "newdeaf-page" });
        parsed = parseNewdeafPage(html, candidate);
        if (parsed.ortified.length || parsed.opravar.length || parsed.allo.length) break;
      } catch (error) {
        log("newdeaf-warn", "page candidate failed", { candidate, message: error.message });
      }
    }
    if (!parsed) throw new Error("Не удалось загрузить страницу newdeaf");
    // Only persist a page that actually exposed a player; an empty parse may be
    // a transient mirror miss we don't want to pin for 24h.
    if (parsed.ortified.length || parsed.opravar.length || parsed.allo.length) cacheSet("ndpage", pageUrl, parsed, TTL.ndpage);
    return parsed;
  }

  // =====================================================================
  // Router (path-based; hash links remain readable legacy aliases)
  // =====================================================================
  function parseLocationRoute() {
    const legacy = parseLegacyHash(location.hash);
    if (legacy) return legacy;
    return parsePathRoute(location.pathname, location.search);
  }

  function parseLegacyHash(hash) {
    const h = String(hash || "").replace(/^#/, "");
    if (!h) return null;
    return parsePathRoute(h, "");
  }

  function parsePathRoute(pathname, search = "") {
    const segs = String(pathname || "/").split("/").filter(Boolean).map(safeDecode);
    if (!segs.length) return { view: "home" };
    if (segs[0] === "bookmarks") return { view: "bookmarks" };
    if (segs[0] === "search") return { view: "search", q: segs.slice(1).join("/") };
    if (segs[0] === "watch" && (segs[1] === "clps" || segs[1] === "collaps") && /^\d+$/.test(segs[2] || "")) {
      return { view: "watch", kind: "clps", raw: segs[2], selection: serialSelectionFromEpisodeKey(segs[3]) };
    }
    if (segs[0] === "watch") return { view: "watch", kind: segs[1], raw: segs.slice(2).join("/") || "" };
    if (/^\d+$/.test(segs[0])) return { view: "watch", kind: "zen", raw: segs[0] };
    if (segs[0] === "k" && /^\d+$/.test(segs[1] || "")) return { view: "watch", kind: "kp", raw: segs[1] };
    if (segs[0] === "m" && /^\d+$/.test(segs[1] || "")) return { view: "watch", kind: "soap", raw: segs[1] };
    if (segs[0] === "l" && /^\d+$/.test(segs[1] || "")) {
      return { view: "watch", kind: "lift", raw: segs[1], selection: serialSelectionFromEpisodeKey(segs[2]) };
    }
    if (segs[0] === "r" && /^\d+$/.test(segs[1] || "")) {
      return {
        view: "watch",
        kind: "rezka",
        raw: segs[1],
        kpId: /^\d+$/.test(segs[2] || "") ? segs[2] : "",
      };
    }
    if (segs[0] === "c" && /^\d+$/.test(segs[1] || "")) {
      return { view: "watch", kind: "clps", raw: segs[1], selection: serialSelectionFromEpisodeKey(segs[2]) };
    }
    if (segs[0] === "o" && /^\d+$/.test(segs[1] || "")) {
      return { view: "watch", kind: "ort", raw: ortifiedUrlFromShort(segs[1], segs[2]) };
    }
    if (segs[0] === "n") {
      const pageUrl = newdeafUrlFromShortPath(segs.slice(1));
      if (pageUrl) return { view: "watch", kind: "nd", raw: pageUrl };
    }
    return { view: "home" };
  }

  function routePath(input) {
    const value = String(input || "/");
    if (value.startsWith("/watch/")) {
      const route = parsePathRoute(value, "");
      const target = targetFromWatchRoute(route);
      if (target) return hashFor(target);
    }
    if (value.startsWith("/search/")) {
      const route = parsePathRoute(value, "");
      if (route.view === "search") return `/search/${encodeURIComponent(route.q)}`;
    }
    return value.startsWith("/") ? value : "/";
  }

  function targetFromWatchRoute(route) {
    if (route.view !== "watch") return null;
    if (route.kind === "kp") return { kind: "kp", kpId: route.raw };
    if (route.kind === "zen") return { kind: "zen", zenithId: route.raw };
    if (route.kind === "ort") return { kind: "ort", embedUrl: route.raw };
    if (route.kind === "opr") return { kind: "opr", playerUrl: route.raw };
    if (route.kind === "nd") return { kind: "nd", pageUrl: route.raw };
    if (route.kind === "soap") return { kind: "soap", soapId: route.raw };
    if (route.kind === "lift") return liftwTarget(route.raw, route.selection || {});
    if (route.kind === "clps") return collapsTarget(route.raw, route.selection || {});
    if (route.kind === "rezka") return rezkaTarget(route.raw, route.kpId);
    return null;
  }

  function go(path) {
    const next = routePath(path);
    const current = new URL(location.href);
    const target = new URL(next, location.origin);
    if (TIZEN_VIDEO_MODE && parsePathRoute(target.pathname).view === "watch") {
      // A remote-control click is a real play intent, but Tizen drops transient
      // user activation before the async resolver completes. Carry only that
      // intent across the navigation; direct links still open paused.
      state.tizenPlayIntentUntil = Date.now() + 30000;
    }
    if (`${current.pathname}${current.search}${current.hash}` === `${target.pathname}${target.search}${target.hash}`) { route(); return; }
    history.pushState(null, "", next);
    route();
  }
  function replaceHash(path) {
    history.replaceState(null, "", routePath(path)); // no popstate, no history entry
  }

  async function route() {
    // Flush while the old target and old <video> still belong to one another.
    // teardownPlayer may also run during an in-place quality/episode switch,
    // where persisting the old position under the new selection would be wrong.
    flushTrackedProgress();
    flushOrtProgress();
    const r = parseLocationRoute();
    const token = nextToken();
    await teardownPlayer();
    hideError();
    el.settingsPanel.classList.add("hidden");
    try {
      if (r.view === "search") {
        await showSearch(r.q, token);
      } else if (r.view === "bookmarks") {
        showBookmarks();
      } else if (r.view === "watch") {
        await showWatch(r, token);
      } else {
        showHome();
      }
    } catch (error) {
      if (!isStale(token)) showError(error);
    }
  }

  // =====================================================================
  // Views
  // =====================================================================
  function setView(name) {
    el.homeView.classList.toggle("hidden", name !== "home");
    el.bookmarksView.classList.toggle("hidden", name !== "bookmarks");
    el.searchView.classList.toggle("hidden", name !== "search");
    el.soapView?.classList.toggle("hidden", name !== "soap");
    el.watchView.classList.toggle("hidden", name !== "watch");
    el.bookmarksToggle.classList.toggle("active", name === "bookmarks");
    document.documentElement.classList.toggle("view-watch", name === "watch");
    window.dispatchEvent(new CustomEvent("alphy:view", { detail: { view: name } }));
  }

  // Shaka is ~400KB from jsdelivr and is on the critical path of essentially every
  // play. Fetching it while the homepage sits idle moves that download out of the
  // click and into dead time; afterwards it is an HTTP-cache hit forever. Skipped
  // on metered/slow links, where the spend would not be repaid.
  function preloadPlayerRuntime() {
    const connection = navigator.connection || {};
    if (connection.saveData) return;
    if (/^(slow-)?2g$/.test(String(connection.effectiveType || ""))) return;
    scheduleIdle(() => { ensureShaka().catch(() => {}); }, 4000);
  }

  function showHome() {
    setView("home");
    warmNewdeafConnections();
    warmCollapsConnections();
    preloadPlayerRuntime();
    document.title = SITE_TITLE;
    el.searchInput.value = "";
    const rawHistory = loadList(STORE_HISTORY);
    const hist = collapseHistory(rawHistory);
    if (hist.length !== rawHistory.length || hist.some((entry, index) => entry.key !== rawHistory[index]?.key)) {
      saveList(STORE_HISTORY, hist.slice(0, 30));
    }
    renderContinueHeader(hist.length);
    renderHomeGrid(el.continueGrid, el.continueSection, hist, {
      withProgress: true,
      store: STORE_HISTORY,
      featureLatest: true,
    });
  }

  function showBookmarks() {
    setView("bookmarks");
    document.title = `Закладки — ${SITE_TITLE}`;
    el.searchInput.value = "";
    const entries = loadList(STORE_BOOKMARKS);
    el.bookmarksGrid.replaceChildren();
    el.bookmarksCount.textContent = String(entries.length);
    el.bookmarksCount.classList.toggle("hidden", entries.length === 0);
    el.bookmarksEmpty.classList.toggle("hidden", entries.length > 0);
    entries.forEach((entry) => {
      const target = entry.target;
      const card = makeCard({
        title: entry.title || "(без названия)",
        sub: [entry.year, entry.isSeries ? "сериал" : "фильм"].filter(Boolean).join(" · "),
        poster: entry.poster,
        rating: entry.rating,
        movieLength: entry.movieLength,
        isSeries: entry.isSeries,
        bookmark: { target, details: entry },
        onBookmarkChange: () => showBookmarks(),
        onClick: () => go(hashFor(target)),
      });
      el.bookmarksGrid.appendChild(card);
    });
    layoutMobileGrid(el.bookmarksGrid);
  }

  function renderHomeGrid(grid, section, entries, opts) {
    grid.replaceChildren();
    if (!entries.length) { section.classList.add("hidden"); return; }
    section.classList.remove("hidden");
    entries.slice(0, 20).forEach((entry, index) => {
      if (opts.withProgress) {
        grid.appendChild(makeContinueCard(entry, index, opts));
        return;
      }
      let sub = entry.year ? String(entry.year) : "";
      const card = makeCard({
        title: entry.title || "(без названия)",
        sub,
        poster: entry.poster,
        rating: entry.rating,
        movieLength: entry.movieLength,
        isSeries: entry.isSeries,
        bookmark: opts.store === STORE_BOOKMARKS ? { target: entry.target, details: entry } : null,
        onClick: () => go(hashFor(entry.target)),
        onRemove: () => {
          const list = loadList(opts.store).filter((x) => x.key !== entry.key);
          saveList(opts.store, list);
          showHome();
        },
      });
      grid.appendChild(card);
    });
    if (!opts.withProgress) layoutMobileGrid(grid);
  }

  function layoutMobileGrid(grid) {
    if (!grid) return;
    const cards = [...grid.children].filter((child) => child.classList.contains("card"));
    const twoRows = cards.length > 4;
    const topCount = twoRows ? Math.ceil(cards.length / 2) : cards.length;
    grid.classList.toggle("mobile-two-row", twoRows);
    cards.forEach((card, index) => {
      const top = !twoRows || index < topCount;
      card.style.setProperty("--mobile-row", top ? "1" : "2");
      card.style.setProperty("--mobile-column", String(top ? index + 1 : index - topCount + 1));
    });
  }

  function renderContinueHeader(count) {
    if (!el.continueHeader) return;
    el.continueHeader.replaceChildren(document.createTextNode("Продолжить просмотр"));
    if (!count) return;
    const badge = document.createElement("span");
    badge.className = "continue-count";
    badge.textContent = String(count);
    el.continueHeader.appendChild(badge);
  }

  function makeContinueCard(entry, index, opts) {
    const featured = !!opts.featureLatest && index === 0;
    const card = document.createElement("article");
    card.className = `card continue-card${featured ? " continue-featured" : ""}`;
    card.tabIndex = 0;
    card.setAttribute("role", "button");

    const media = document.createElement("div");
    media.className = "card-media continue-media";
    const imageUrl = featured && entry.snapshot ? entry.snapshot : entry.poster || entry.snapshot;
    if (imageUrl) {
      const image = document.createElement("img");
      image.className = "poster";
      image.loading = featured ? "eager" : "lazy";
      image.src = imageUrl;
      image.alt = "";
      image.addEventListener("error", () => image.replaceWith(blankPoster()));
      media.appendChild(image);
    } else {
      media.appendChild(blankPoster());
    }
      const nativeLink = document.createElement("a");
      nativeLink.className = "card-native-link";
      nativeLink.href = routePath(hashFor(entry.target));
      nativeLink.tabIndex = -1;
    nativeLink.setAttribute("aria-label", `Открыть ${entry.title || "тайтл"}`);
    media.appendChild(nativeLink);

    const play = document.createElement("span");
    play.className = `continue-play${featured ? " continue-play-image" : ""}`;
    play.setAttribute("aria-hidden", "true");
    if (featured) {
      const playImage = document.createElement("img");
      playImage.src = typeof window.__alphyAssetUrl === "function"
        ? window.__alphyAssetUrl("continue-play.png")
        : "/continue-play.png";
      playImage.alt = "";
      playImage.setAttribute("aria-hidden", "true");
      playImage.decoding = "async";
      playImage.addEventListener("error", () => {
        // Keep the original CSS triangle as a safe fallback if the CDN asset
        // is unavailable; the rest of the card remains unchanged.
        play.replaceChildren();
        play.classList.remove("continue-play-image");
      }, { once: true });
      play.appendChild(playImage);
    }
    media.appendChild(play);

    const progress = continueProgress(entry);
    const overlay = document.createElement("div");
    overlay.className = "continue-overlay";
    overlay.innerHTML = `
      <div class="continue-status">${escapeHtml(continueStatus(entry))}</div>
      <div class="continue-progress" aria-hidden="true">
        <div class="continue-progress-bar" style="width:${Math.round(progress * 100)}%"></div>
      </div>
    `;
    media.appendChild(overlay);

    addCardBookmark(media, entry.target, entry);

    const remove = document.createElement("button");
    remove.className = "card-remove";
    remove.type = "button";
    remove.innerHTML = `<span class="card-remove-glyph" aria-hidden="true">×</span>`;
    remove.setAttribute("aria-label", "Убрать из продолжения");
    remove.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const list = loadList(opts.store).filter((item) => item.key !== entry.key);
      saveList(opts.store, list);
      showHome();
    });
    media.appendChild(remove);
    card.appendChild(media);

    const title = document.createElement("div");
    title.className = "ctitle";
    title.textContent = entry.title || "(без названия)";
    card.appendChild(title);
    if (entry.year) {
      const year = document.createElement("div");
      year.className = "cmeta";
      year.textContent = String(entry.year);
      card.appendChild(year);
    }

    const open = () => go(hashFor(entry.target));
    card.addEventListener("click", (event) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      open();
    });
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });
    armCardIntent(card, entry.target, entry);
    return card;
  }

  function continueProgress(entry) {
    const value = Number(entry?.progress);
    const duration = Number(entry?.duration);
    const position = Number(entry?.position);
    const derived = duration > 0 && position > 0 ? Math.min(1, position / duration) : 0;
    if (Number.isFinite(value) && value > 0) return Math.min(1, value);
    return derived;
  }

  function continueStatus(entry) {
    const selection = entry?.serialSelection || entry?.opravarSelection || entry?.collapsSelection || null;
    const season = positiveInt(selection?.season);
    const episode = positiveInt(selection?.episode);
    const episodeLabel = season && episode ? `S${season}E${episode}` : "";
    const duration = Number(entry?.duration);
    const position = Number(entry?.position);
    const left = duration > 0
      ? Math.max(0, Math.ceil((duration - Math.max(0, position || 0)) / 60))
      : null;
    if (episodeLabel && left != null) return `${episodeLabel} · ${left} мин осталось`;
    if (episodeLabel) return episodeLabel;
    if (left != null) return `${left} мин осталось`;
    const progress = Math.round(continueProgress(entry) * 100);
    return progress > 0 ? `${progress}% просмотрено` : "Продолжить";
  }

  async function showSearch(query, token) {
    setView("search");
    warmNewdeafConnections();
    warmCollapsConnections();
    document.title = `${query} — ${SITE_TITLE}`;
    el.searchInput.value = query;
    el.resultsTitle.textContent = "Поиск…";
    el.resultsGrid.replaceChildren();

    // SOAP titles are overwhelmingly Latin. Avoid competing with PoiskKino,
    // Newdeaf and posters for a 600KB catalog on ordinary Russian searches.
    const wantsSoap = /[a-z]/i.test(query);
    if (wantsSoap) warmSoapConnections();
    const soapTask = wantsSoap ? loadSoapCatalog() : Promise.resolve([]);
    const poiskTask = searchPoiskkino(query)
      .then((results) => ({ results }))
      .catch((error) => {
        log("poisk-error", error.message);
        return { results: [] };
      });

    let pk = [];
    let nd = [];
    let liftw = [];
    let clps = [];
    let rezka = [];
    let newdeafUnavailable = false;
    let liftwUnavailable = false;
    let collapsProbeKey = "";
    let collapsScheduledKey = "";
    let rezkaProbeKey = "";
    let rezkaScheduledKey = "";
    const renderCurrent = () => renderResults(nd, pk, query, {
      newdeafUnavailable,
      liftwUnavailable,
      liftwHits: liftw,
      collapsHits: clps,
      rezkaHits: rezka,
    });
    const startRezkaProbe = (movies, { immediate = false } = {}) => {
      const candidates = (movies || []).filter((m) => !m?.isSeries).slice(0, REZKA_PREVIEW_LIMIT);
      const ids = candidates.map((m) => m.kpId).filter(Boolean).join(",");
      if (!ids || ids === rezkaProbeKey || ids === rezkaScheduledKey || rezkaPreviewOnCooldown()) return;
      rezkaScheduledKey = ids;
      const run = () => {
        if (isStale(token) || rezkaScheduledKey !== ids || rezkaPreviewOnCooldown()) return;
        rezkaScheduledKey = "";
        rezkaProbeKey = ids;
        probeRezkaSearch(candidates, token)
          .then((hits) => {
            rezka = hits;
            if (!isStale(token)) renderCurrent();
          })
          .catch((error) => log("rezka-probe-warn", error.message));
      };
      if (immediate) run();
      else scheduleIdle(run, COLLAPS_PREVIEW_IDLE_TIMEOUT);
    };
    const startCollapsProbe = (movies) => {
      const ids = (movies || []).map((m) => m.kpId).filter(Boolean).slice(0, COLLAPS_PREVIEW_LIMIT).join(",");
      if (!ids || ids === collapsProbeKey || ids === collapsScheduledKey) return;
      if (collapsPreviewOnCooldown()) {
        startRezkaProbe(movies);
        return;
      }
      collapsScheduledKey = ids;
      scheduleIdle(() => {
        if (isStale(token) || collapsScheduledKey !== ids) return;
        if (collapsPreviewOnCooldown()) {
          collapsScheduledKey = "";
          startRezkaProbe(movies, { immediate: true });
          return;
        }
        collapsScheduledKey = "";
        collapsProbeKey = ids;
        probeCollapsSearch(movies, token)
          .then((hits) => {
            clps = hits;
            const topId = String((movies || []).find((m) => !m?.isSeries)?.kpId || "");
            if (!hits.some((hit) => String(hit.kpId) === topId)) startRezkaProbe(movies, { immediate: true });
            if (!isStale(token)) renderCurrent();
          })
          .catch((error) => {
            log("collaps-probe-warn", error.message);
            startRezkaProbe(movies, { immediate: true });
          });
      }, COLLAPS_PREVIEW_IDLE_TIMEOUT);
    };
    const liftwTask = searchLiftw(query)
      .then((results) => {
        liftw = results;
        if (!isStale(token)) renderCurrent();
        return results;
      })
      .catch((error) => {
        liftwUnavailable = true;
        log("liftw-error", error.message);
        if (!isStale(token)) renderCurrent();
        return [];
      });
    const canStartNewdeafNow = /[а-яё]/i.test(query);
    const newdeafTask = canStartNewdeafNow
      ? searchNewdeaf(query)
        .then((results) => ({ results, unavailable: false }))
        .catch((error) => {
          log("newdeaf-error", error.message);
          return { results: [], unavailable: true };
        })
      : null;

    if (newdeafTask) {
      const first = await Promise.race([
        poiskTask.then((value) => ({ source: "poisk", ...value })),
        newdeafTask.then((value) => ({ source: "newdeaf", ...value })),
      ]);
      if (isStale(token)) return;
      if (first.source === "poisk") pk = first.results;
      else {
        nd = first.results;
        newdeafUnavailable = first.unavailable;
      }
      if (pk.length) startCollapsProbe(pk);
      renderCurrent();

      const [poisk, newdeaf] = await Promise.all([poiskTask, newdeafTask]);
      pk = poisk.results;
      nd = newdeaf.results;
      newdeafUnavailable = newdeaf.unavailable;
      if (pk.length) startCollapsProbe(pk);
    } else {
      const poisk = await poiskTask;
      if (isStale(token)) return;
      pk = poisk.results;
      startCollapsProbe(pk);
      renderCurrent();

      // newdeaf indexes Russian titles only. If the query has no Cyrillic, search
      // newdeaf with the Russian name from the top PoiskKino hit so English queries
      // ("Scavengers Reign") still surface the newdeaf pages ("Царство падальщиков").
      const ndQuery = pickNewdeafQuery(query, pk);
      try {
        nd = await searchNewdeaf(ndQuery);
      } catch (error) {
        newdeafUnavailable = true;
        log("newdeaf-error", error.message);
      }
    }
    if (isStale(token)) return;
    await Promise.all([soapTask, liftwTask]);
    if (isStale(token)) return;
    renderCurrent();
    if (!pk.length && !nd.length && !liftw.length && !clps.length && !rezka.length && !soapSearch(query, { limit: 1 }).length) {
      el.resultsTitle.textContent = "Ничего не найдено";
    }
  }

  function pickNewdeafQuery(query, pkResults) {
    if (/[а-яё]/i.test(query)) return query;
    const ru = (pkResults || []).map((m) => m.name).find((name) => /[а-яё]/i.test(name || ""));
    return ru || query;
  }

  function renderResults(ndCandidates, pkResults, query, options = {}) {
    // Build the whole grid in a detached fragment and swap it in once. Search may
    // render once for the race winner and again for the final merge, so appending
    // card-by-card to the live grid each time would thrash layout for no reason.
    const frag = document.createDocumentFragment();
    el.resultsTitle.textContent = "Результаты";
    if (ndCandidates.length) prefetchTopNewdeafPage(ndCandidates);
    const liftwHits = Array.isArray(options.liftwHits) ? options.liftwHits : [];
    const collapsHits = Array.isArray(options.collapsHits) ? options.collapsHits : [];
    const rezkaHits = Array.isArray(options.rezkaHits) ? options.rezkaHits : [];
    const highCollapsHits = collapsHits.filter((hit) => Number(hit.qualityHeight) >= 1440);
    const regularCollapsHits = collapsHits.filter((hit) => Number(hit.qualityHeight) < 1440);
    for (const hit of highCollapsHits) frag.appendChild(makeCollapsCard(hit));
    // newdeaf first and prioritized: when a title is in both sources, the ad-free
    // Ortified path (newdeaf, with the embedded season/episode player) is the
    // preferred choice, so it leads the grid — same ordering as the old MVP.
    for (const item of ndCandidates) {
      const match = matchNewdeafMetadata(item, pkResults);
      if (match) cacheSet(ND_ENRICHED_CACHE_NS, item.url, match, TTL.enriched);
      const title = item.title || "Newdeaf";
      const target = { kind: "nd", pageUrl: item.url };
      const pageType = newdeafPageType(item);
      const details = {
        title,
        year: match?.year || extractYear(`${item.title || ""} ${item.url || ""}`),
        poster: match?.poster || item.poster || "",
        rating: match?.rating || {},
        movieLength: match?.movieLength || null,
        isSeries: match?.isSeries ?? pageType ?? false,
      };
      // An already-curated title opens through its resolved list target
      // (instant Ortified/Zona) instead of re-running the newdeaf resolve.
      const ready = match
        ? window.alphyCatalog?.findReady?.(movieTitle(match), match.year, !!match.isSeries)
        : null;
      const card = makeCard({
        title,
        sub: [details.year, details.isSeries ? "сериал" : "Newdeaf"].filter(Boolean).join(" · "),
        poster: details.poster,
        imdb: match?.externalId?.imdb || match?.imdbId || "",
        rating: match?.rating,
        movieLength: match?.movieLength,
        isSeries: match?.isSeries,
        originalTitle: match ? (match.originalTitle || match.alternativeName || "") : "",
        year: details.year || match?.year || "",
        bookmark: { target, details },
        intent: { target: ready?.target || target, details },
        onClick: ready
          ? () => openCuratedItem({ ...ready, kpId: ready.kpId || (match?.kpId != null ? String(match.kpId) : "") })
          : () => go(`/watch/nd/${encodeURIComponent(item.url)}`),
      });
      frag.appendChild(card);
    }
    for (const item of liftwHits) frag.appendChild(makeLiftwCard(item));
    for (const hit of regularCollapsHits) frag.appendChild(makeCollapsCard(hit));
    for (const hit of rezkaHits) frag.appendChild(makeRezkaCard(hit));
    for (const movie of pkResults) {
      if (movie.kpId == null) continue;
      const title = movieTitle(movie);
      const target = { kind: "kp", kpId: movie.kpId };
      const details = {
        title,
        year: movie.year || "",
        poster: movie.poster || "",
        rating: movie.rating || {},
        movieLength: movie.movieLength || null,
        isSeries: !!movie.isSeries,
      };
      const ready = window.alphyCatalog?.findReady?.(title, movie.year, !!movie.isSeries);
      const card = makeCard({
        title,
        sub: [movie.year, movie.isSeries ? "сериал" : "фильм"].filter(Boolean).join(" · "),
        poster: movie.poster,
        imdb: movie.isSeries ? "" : movie.externalId?.imdb,
        originalTitle: movie.originalTitle || movie.alternativeName || "",
        year: movie.year || "",
        rating: movie.rating,
        movieLength: movie.movieLength,
        isSeries: movie.isSeries,
        bookmark: { target, details },
        intent: { target: ready?.target || target, details },
        onClick: ready
          ? () => openCuratedItem({ ...ready, kpId: ready.kpId || String(movie.kpId) })
          : () => go(`/watch/kp/${encodeURIComponent(movie.kpId)}`),
      });
      frag.appendChild(card);
    }
    // soap4you as a fallback source (client-side static catalog, account-free
    // playback). Titles are mostly English, so this mainly surfaces on Latin
    // queries; ranked last since Ortified/Zona are preferred when present.
    const soapHits = soapSearch(query, { limit: 12 });
    if (soapHits.length) prefetchTopSoapManifest(soapHits);
    for (const m of soapHits) {
      const target = { kind: "soap", soapId: String(m.id) };
      const details = { title: m.t, poster: soapPoster(m.id), year: "" };
      const card = makeCard({
        title: m.t,
        sub: [soapQualityLabel(m), "soap"].filter(Boolean).join(" · "),
        poster: soapPoster(m.id),
        bookmark: { target, details },
        onClick: () => go(`/m/${m.id}`),
        onAdd: () => window.alphyCatalog?.addToList?.(soapListItem(m)),
      });
      frag.appendChild(card);
    }
    if (options.newdeafUnavailable) {
      const note = document.createElement("p");
      note.className = "muted search-note";
      note.textContent = "Newdeaf не ответил этому браузеру — показаны остальные результаты.";
      frag.appendChild(note);
    }
    if (options.liftwUnavailable) {
      const note = document.createElement("p");
      note.className = "muted search-note";
      note.textContent = "LiftW не ответил этому браузеру — показаны остальные результаты.";
      frag.appendChild(note);
    }
    if (!pkResults.length && !ndCandidates.length && !liftwHits.length && !collapsHits.length && !rezkaHits.length && !soapHits.length) {
      const p = document.createElement("p");
      p.className = "muted";
      p.textContent = `Ничего не найдено по «${query}».`;
      frag.appendChild(p);
    }
    el.resultsGrid.replaceChildren(frag);
    fillGridLetterboxd(el.resultsGrid);
    enrichSearchCardMetadata(pkResults);
  }

  const searchMetaEnrichmentInflight = new Map();
  function enrichSearchCardMetadata(movies) {
    const ids = [...new Set((movies || []).map((movie) => String(movie?.kpId || "")).filter((id) => /^\d+$/.test(id)))];
    if (!ids.length || typeof window.alphyForYou?.enrichItems !== "function") return;
    const key = ids.join(",");
    let task = searchMetaEnrichmentInflight.get(key);
    if (!task) {
      task = Promise.resolve(window.alphyForYou.enrichItems(ids))
        .finally(() => searchMetaEnrichmentInflight.delete(key));
      searchMetaEnrichmentInflight.set(key, task);
    }
    task.then((meta) => {
      const enriched = (movies || []).map((movie) => mergeMetadata(movie, meta?.get?.(String(movie.kpId)) || {}));
      patchCardRowMetadata(el.resultsGrid, enriched);
    }).catch((error) => log("search-meta-warn", error.message));
  }

  function makeLiftwCard(item) {
    const target = liftwTarget(item.id);
    const details = {
      title: item.title,
      year: item.year || "",
      poster: item.poster || "",
      rating: item.rating || {},
      isSeries: !!item.isSeries,
    };
    // "TS" is a cam rip and the one quality worth warning about up front, so it
    // takes the corner pill; anything else is just another caption field.
    const isTelesync = /^ts$/i.test(item.quality || "");
    // 92% of LiftW's serial_status values are a flat "Все серии", which the type
    // label already implies. The rest name the latest episode of a running show,
    // which is the only case worth the space.
    const status = /^все серии$/i.test(item.serialStatus || "") ? "" : item.serialStatus;
    const card = makeCard({
      title: item.title,
      sub: [item.year, item.typeLabel, status, isTelesync ? "" : item.quality, "LFT"].filter(Boolean).join(" · "),
      poster: item.poster,
      imdb: item.externalId?.imdb || item.imdbId || "",
      flag: isTelesync ? "TS" : "",
      rating: item.rating,
      isSeries: item.isSeries,
      originalTitle: item.originalTitle || "",
      year: item.year || "",
      bookmark: { target, details },
      onClick: () => go(hashFor(target)),
      onAdd: () => window.alphyCatalog?.addToList?.(liftwListItem(item, details)),
    });
    card.classList.add("liftw-card");
    // The search payload carries no runtime — only /info does. Rather than fan a
    // request out per result, ride the hover warm-up that already fetches it (and
    // a cache hit from an earlier visit) and fill the duration in when it lands.
    applyLiftwDuration(card, cacheGet(LIFTW_TITLE_CACHE_NS, String(item.id)));
    // One hovered card warms the whole title: /info + embed land in the TTL cache
    // and the click then goes straight to Shaka.
    card.addEventListener("pointerenter", () => {
      prefetchLiftwTitle(item.id)?.then((parsed) => applyLiftwDuration(card, parsed), () => {});
    }, { once: true });
    return card;
  }

  function applyLiftwDuration(card, parsed) {
    if (!parsed?.meta) return;
    setCardDuration(card, parsed.meta.movieLength, parsed.meta.isSeries);
  }

  function makeCollapsCard(hit) {
    const target = collapsTarget(hit.kpId, hit.selection || {});
    const details = {
      title: hit.title || `KP ${hit.kpId}`,
      year: hit.year || "",
      poster: hit.poster || "",
      rating: hit.rating || {},
      movieLength: hit.movieLength || null,
      isSeries: !!hit.isSeries,
      kpId: String(hit.kpId || ""),
    };
    const quality = hit.qualityLabel || "MP4";
    return makeCard({
      title: details.title,
      sub: [quality, details.isSeries ? "сериал" : "фильм", "CLPS"].filter(Boolean).join(" · "),
      poster: details.poster,
      imdb: hit.externalId?.imdb || hit.imdbId || "",
      rating: details.rating,
      movieLength: details.movieLength,
      isSeries: details.isSeries,
      originalTitle: hit.originalTitle || hit.alternativeName || "",
      year: details.year || "",
      bookmark: { target, details },
      onClick: () => go(hashFor(target)),
      onAdd: () => window.alphyCatalog?.addToList?.(collapsListItem(hit, details)),
    });
  }

  function makeRezkaCard(hit) {
    const target = rezkaTarget(hit.rezkaId, hit.kpId);
    const details = {
      title: hit.title || `Фильм ${hit.rezkaId}`,
      year: hit.year || "",
      poster: hit.poster || "",
      rating: hit.rating || {},
      movieLength: hit.movieLength || null,
      isSeries: false,
      kpId: String(hit.kpId || ""),
    };
    return makeCard({
      title: details.title,
      sub: ["720p", "фильм", "RZK"].join(" · "),
      poster: details.poster,
      imdb: hit.externalId?.imdb || hit.imdbId || "",
      rating: details.rating,
      movieLength: details.movieLength,
      isSeries: false,
      originalTitle: hit.originalTitle || "",
      year: details.year || "",
      bookmark: { target, details },
      onClick: () => openRezkaHit(hit, details),
      onAdd: () => window.alphyCatalog?.addToList?.(rezkaListItem(hit, details)),
    });
  }

  function makeCard({
    title,
    sub,
    poster,
    flag,
    imdb,
    rating,
    movieLength,
    isSeries,
    originalTitle,
    year,
    bookmark,
    intent,
    recommendation,
    onBookmarkChange,
    onClick,
    onRemove,
    onAdd,
  }) {
    const card = document.createElement("article");
    card.className = "card";
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    // A card declares who it is, not just what it scored. Only the Kinopoisk
    // path arrives with an id; every other source (lift:, zen:, ort:, clps:,
    // the curated catalogue) gets one resolved from these, off the metered API.
    if (/^tt\d{6,10}$/.test(String(imdb || ""))) card.dataset.imdb = imdb;
    if (title) card.dataset.title = title;
    if (originalTitle) card.dataset.originalTitle = originalTitle;
    const declaredYear = String(year || "").slice(0, 4);
    if (declaredYear) card.dataset.year = declaredYear;
    if (isSeries) card.dataset.series = "1";
    const media = document.createElement("div");
    media.className = "card-media";
    const imageUrl = poster;
    if (imageUrl) {
      const img = document.createElement("img");
      img.className = "poster";
      img.loading = "lazy";
      img.decoding = "async";
      img.referrerPolicy = "no-referrer";
      img.src = imageUrl;
      img.alt = "";
      img.addEventListener("error", () => { img.replaceWith(blankPoster()); });
      media.appendChild(img);
    } else {
      media.appendChild(blankPoster());
    }
    const nativeTarget = recommendation?.target || intent?.target || bookmark?.target;
    const nativeKpId = validHistoryKpId(nativeTarget?.kpId, bookmark?.details?.kpId, recommendation?.kpId);
    if (nativeKpId) card.dataset.kpId = nativeKpId;
    if (nativeTarget?.kind) {
      const nativeLink = document.createElement("a");
      nativeLink.className = "card-native-link";
      nativeLink.href = routePath(hashFor(nativeTarget));
      nativeLink.tabIndex = -1;
      nativeLink.setAttribute("aria-label", `Открыть ${title || "тайтл"}`);
      media.appendChild(nativeLink);
    }
    // The corner pill is a warning, not a label: it exists to call out a release
    // you probably do not want (a TS cam rip, a 720p-only last resort). The source
    // itself rides in the caption line under the poster like every other field.
    if (flag) {
      const pill = document.createElement("div");
      pill.className = "card-flag";
      pill.textContent = flag;
      media.appendChild(pill);
    }
    const hover = document.createElement("div");
    hover.className = "card-hover-meta";
    hover.setAttribute("aria-hidden", "true");
    hover.innerHTML = `
      <div class="hover-ratings">
        <div class="hover-rating">
          <span class="hover-rating-name">IMDb</span>
          <b class="hover-rating-value">${formatRating(rating?.imdb)}</b>
        </div>
        <i class="hover-rating-divider"></i>
        <div class="hover-rating">
          <span class="hover-rating-name">КП</span>
          <b class="hover-rating-value">${formatRating(rating?.kp)}</b>
        </div>
      </div>
    `;
    renderHoverDuration(hover, movieLength, isSeries);
    media.appendChild(hover);
    if (bookmark?.target) {
      addCardBookmark(media, bookmark.target, bookmark.details, onBookmarkChange);
    }
    if (onAdd) {
      // Admin-only "add to curated list" affordance (hidden unless body.admin-mode).
      const add = document.createElement("button");
      add.className = "card-add-list";
      add.type = "button";
      add.setAttribute("aria-label", "Добавить в подборку");
      add.textContent = "+";
      add.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); onAdd(); });
      media.appendChild(add);
    }
    if (onRemove) {
      const x = document.createElement("button");
      x.className = "card-remove";
      x.type = "button";
      x.setAttribute("aria-label", "Скрыть рекомендацию");
      x.innerHTML = `<span class="card-remove-glyph" aria-hidden="true">×</span>`;
      x.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); onRemove(); });
      media.appendChild(x);
    }
    card.appendChild(media);
    const t = document.createElement("div");
    t.className = "ctitle";
    t.textContent = title;
    card.appendChild(t);
    if (sub) {
      const s = document.createElement("div");
      s.className = "cmeta";
      s.textContent = sub;
      card.appendChild(s);
    }
    const activate = () => {
      const result = onClick?.();
      if (result && typeof result.then === "function") {
        card.classList.add("card-resolving");
        card.setAttribute("aria-busy", "true");
        const clear = () => {
          card.classList.remove("card-resolving");
          card.removeAttribute("aria-busy");
        };
        Promise.resolve(result).then(clear, clear);
      }
    };
    card.addEventListener("click", (event) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      activate();
    });
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activate();
      }
    });
    if (recommendation?.target) armRecommendationIntent(card, recommendation);
    else {
      const prep = intent || bookmark;
      if (prep?.target) armCardIntent(card, prep.target, prep.details || {});
    }
    return card;
  }
  function blankPoster() {
    const d = document.createElement("div");
    d.className = "poster";
    return d;
  }

  function formatRating(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number.toFixed(1) : "—";
  }

  function formatDuration(value, isSeries = false) {
    const minutes = Math.round(Number(value));
    if (Number.isFinite(minutes) && minutes > 0) {
      if (minutes >= 60) {
        const hours = Math.floor(minutes / 60);
        const rest = minutes % 60;
        return `${hours} ч${rest ? ` ${rest} м` : ""}`;
      }
      return `${minutes} мин`;
    }
    // Not every source ships a runtime. A bare dash under the ratings reads like
    // a broken field, so an unknown duration renders as nothing at all.
    return isSeries ? "СЕРИАЛ" : "";
  }

  // The slot is created only when there is something to put in it, and can be
  // filled in later — LiftW learns a runtime only once the title itself is
  // fetched, which happens on hover rather than for every search result.
  function renderHoverDuration(hover, movieLength, isSeries) {
    if (!hover) return;
    const text = formatDuration(movieLength, isSeries);
    let node = hover.querySelector(".hover-duration");
    if (!text) {
      node?.remove();
      return;
    }
    if (!node) {
      node = document.createElement("div");
      node.className = "hover-duration";
      hover.appendChild(node);
    }
    node.textContent = text;
  }

  function setCardDuration(card, movieLength, isSeries) {
    renderHoverDuration(card?.querySelector?.(".card-hover-meta"), movieLength, isSeries);
  }

  // Letterboxd gets a centred row of its own beneath IMDb and КП, rather than a
  // third column squeezed in beside them: three figures across a cover crowded
  // the row and forced every number smaller. Stacking keeps all three at the
  // size a two-rating card has always used.
  function setCardLetterboxd(card, rating) {
    const hover = card?.querySelector?.(".card-hover-meta");
    if (!hover || !rating?.r || hover.querySelector(".hover-rating-lb")) return;
    const row = document.createElement("div");
    row.className = "hover-rating hover-rating-lb";
    row.innerHTML = `<span class="hover-rating-name">LB</span>` +
      `<b class="hover-rating-value">${escapeHtml(letterboxdOutOfTen(rating.r))}</b>`;
    // The runtime keeps the bottom of the stack, whichever arrives first.
    const runtime = hover.querySelector(".hover-duration");
    if (runtime) hover.insertBefore(row, runtime);
    else hover.appendChild(row);
  }

  // Reviews ride inside the same film page the rating is scraped from, so they
  // cost nothing extra upstream. They are asked for only here, one film at a
  // time, and never by a grid.
  // Bidirectional overrides reorder every character rendered after them, so a
  // display name carrying one can rearrange the line it sits in. The resolver
  // already strips these; this is the same guarantee made where the text is
  // actually rendered, because that is the side that has to hold.
  const stripBidi = (text) =>
    String(text || "").replace(/[\u0000-\u001f\u007f\u00ad\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "");

  function storeLetterboxdReviews(id, reviews) {
    const list = reviews
      .filter((item) => item && typeof item.t === "string" && item.t.trim())
      .slice(0, 6)
      .map((item) => ({
        a: stripBidi(compact(item.a)).slice(0, 40),
        r: Number(item.r) > 0 && Number(item.r) <= 5 ? Number(item.r) : 0,
        t: stripBidi(compact(item.t)).slice(0, 600),
        c: !!item.c,
        s: !!item.s,
      }));
    cacheSet(LETTERBOXD_REVIEWS_NS, id, { list }, list.length ? TTL.letterboxd : TTL.letterboxdmiss);
    return list.length ? list : null;
  }

  async function letterboxdReviews(imdb) {
    const id = String(imdb || "").trim();
    if (!/^tt\d{6,10}$/.test(id)) return null;
    const cached = cacheGet(LETTERBOXD_REVIEWS_NS, id);
    if (cached) return cached.list?.length ? cached.list : null;
    // The same request the score comes from, shared with it when both are wanted.
    const first = await letterboxdFilm(id);
    if (first.reviews !== undefined) return first.reviews;
    // A shard on an older build answers with the rating and no reviews key at
    // all. That is not "this film has none" — it never spoke to the question,
    // so the rest of the ring is asked rather than an absence cached.
    const order = letterboxdEndpointOrder(id);
    const rest = first.answeredBy ? order.slice(order.indexOf(first.answeredBy) + 1) : order;
    const now = Date.now();
    for (const endpoint of rest) {
      if ((letterboxdCooldown.get(endpoint) || 0) > now) continue;
      let payload = null;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 12000);
        const response = await fetch(`${endpoint}?imdb=${encodeURIComponent(id)}&reviews=1`, {
          signal: controller.signal,
          referrerPolicy: "no-referrer",
        });
        clearTimeout(timer);
        if (!response.ok) throw new Error(`http ${response.status}`);
        payload = await response.json();
      } catch (error) {
        letterboxdCooldown.set(endpoint, now + LETTERBOXD_COOLDOWN_MS);
        log("letterboxd-reviews-warn", { endpoint, message: error.message });
        continue;
      }
      // Deliberately outside the catch above: only a failed request should cool
      // a project down, never one that is merely a version behind.
      if (!Array.isArray(payload?.reviews)) continue;
      return storeLetterboxdReviews(id, payload.reviews);
    }
    return null;
  }

  // The published curated snapshot carries each film's score as it stood when
  // the snapshot was baked, so the home rows paint without asking anyone. Only
  // the fields a card already shows are read; anything malformed is ignored.
  function bakedLetterboxd(card) {
    const raw = card?.dataset?.lb;
    if (!raw) return null;
    try {
      const value = JSON.parse(raw);
      const score = Number(value?.r);
      if (score === 0) return { r: 0 };
      if (!(Number.isFinite(score) && score > 0 && score <= 5)) return null;
      return { r: score, n: positiveInt(value.n), slug: compact(value.slug).slice(0, 120) };
    } catch {
      return null;
    }
  }

  // Called once per rendered grid: collect what the cards declared, ask the
  // shards for whatever is not already known, then paint from the cache.
  async function fillGridLetterboxd(grid) {
    const all = [...(grid?.querySelectorAll?.(".card") || [])];
    if (!all.length) return;

    const known = (card) => (card.dataset.imdb && cacheGet(LETTERBOXD_CACHE_NS, card.dataset.imdb))
      || bakedLetterboxd(card);
    const paint = () => {
      for (const card of all) {
        const value = known(card);
        if (value?.r > 0) setCardLetterboxd(card, value);
      }
    };
    paint();

    // A card the snapshot already answered for costs nothing further: no
    // identity lookup, no request.
    const open = all.filter((card) => !bakedLetterboxd(card));

    // Letterboxd has no page for a series, so a series is never worth an
    // identity lookup here — it would spend a request to learn nothing.
    const nameless = open.filter((card) => (
      !card.dataset.imdb && card.dataset.title && card.dataset.year && !card.dataset.series
    ));
    if (nameless.length && window.alphyIdentity) {
      const resolved = await window.alphyIdentity.resolveMany(nameless.map((card) => ({
        title: card.dataset.title,
        originalTitle: card.dataset.originalTitle || "",
        year: card.dataset.year,
        isSeries: false,
        card,
      })));
      for (const [item, id] of resolved) item.card.dataset.imdb = id;
    }

    const ids = open.map((card) => card.dataset.imdb).filter(Boolean);
    if (!ids.length) return;
    try {
      await letterboxdBatch(ids);
    } catch { /* a shard being down must not cost the grid its other numbers */ }
    paint();
  }

  // =====================================================================
  // Watch dispatch
  // =====================================================================
  async function showWatch(r, token) {
    setView("watch");
    state.playerReady = false;
    state.currentMeta = null;
    lastMetaRenderSignature = "";
    state.zenithEmbedUrl = "";
    window.dispatchEvent(new CustomEvent("alphy:player-ready", { detail: { ready: false } }));
    el.metaPanel.classList.add("hidden");
    // The panel normally reuses stable poster/rating nodes across incremental
    // metadata updates. A route change is a hard ownership boundary: leaving the
    // old DOM here let a film's Letterboxd badge be adopted by the next series.
    el.metaPanel.replaceChildren();
    delete el.metaPanel.dataset.watchToken;
    el.serialPanel.classList.add("hidden");
    el.trackPanel.classList.add("hidden");
    watchExtrasKey = "";
    hideSimilarRow();
    hideReviews();
    // Show the loading state immediately so the previous title's player is never
    // left on screen while the new one resolves (or fails to resolve).
    showPlayerLoading();
    if (r.kind === "kp") return playKp(r.raw, token);
    if (r.kind === "zen") return playZen(r.raw, token);
    if (r.kind === "ort") return playOrt(r.raw, token, null);
    if (r.kind === "opr") return playOpr(r.raw, token, null);
    if (r.kind === "nd") return playNd(r.raw, token);
    if (r.kind === "soap") return playSoap(r.raw, token);
    if (r.kind === "lift") return playLiftw(r.raw, token, { serialSelection: r.selection });
    if (r.kind === "clps") return playCollaps(r.raw, token, { selection: r.selection });
    if (r.kind === "rezka") return playRezkaRoute(r.raw, r.kpId, token);
    throw new Error("Неизвестный тип контента");
  }

  // soap4you movie playback is a plain HLS master with adaptive video, audio
  // tracks, and in-manifest subtitles. The stored URL is account-free once fresh:
  // no resolver, no backend, no soap session during playback.
  async function playSoap(soapId, token) {
    await loadSoapCatalog();
    if (isStale(token)) return;
    const movie = soapMovies.get(String(soapId));
    if (movie?.m) warmSoapConnections(movie.m);
    const cachedMeta = cacheGet("curatedmeta", `soap:${soapId}`) || storedMeta(`soap:${soapId}`);
    const title = movie?.t || cachedMeta?.title || `Movie ${soapId}`;
    const target = {
      kind: "soap",
      soapId: String(soapId),
      title,
      poster: cachedMeta?.poster || soapPoster(soapId),
      year: cachedMeta?.year || "",
      isSeries: false,
    };
    state.currentTarget = target;
    setWatchHead(title, target);
    renderMeta(
      {
        title,
        poster: target.poster,
        year: target.year,
        description: cachedMeta?.description || "",
        rating: cachedMeta?.rating || {},
        movieLength: cachedMeta?.movieLength || null,
      },
      target,
    );
    recordOpen(target);
    if (!movie || !movie.m) throw new Error("Фильм отсутствует в каталоге soap");
    // soap serves demuxed TS HLS which Shaka's transmuxer mishandles (Firefox
    // audio-decode errors, Chrome/Safari black HEVC video). hls.js is the proven
    // player for exactly this — same one soap's own player.js uses.
    await playSoapHls(movie.m, token, {
      resume: resumePosition(keyFor(target)),
      audioLang: savedAudioLang(keyFor(target)),
    });
    if (isStale(token)) return;
    startTracking(keyFor(target), target);
  }

  // Prefer H.264 (avc1) ladder; HEVC-in-TS via MSE renders black in Chrome, and
  // every sampled soap 4K title has a full avc1 ladder, so avc1 covers all resolutions.
  function soapAvcLevels(hls) {
    return (hls.levels || [])
      .map((l, i) => ({ ...l, _i: i }))
      .filter((l) => !/hvc1|hev1|hevc/i.test(l.videoCodec || ""))
      .sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bitrate || 0) - (a.bitrate || 0));
  }
  function removeSoapHevcLevels(hls) {
    const levels = hls.levels || [];
    for (let i = levels.length - 1; i >= 0; i -= 1) {
      if (/hvc1|hev1|hevc/i.test(levels[i]?.videoCodec || "")) {
        try { hls.removeLevel(i); } catch (error) { log("soap-hevc-filter-warn", error.message); }
      }
    }
  }
  function soapAudioName(t, i) {
    return t?.name || t?.label || t?.lang || t?.language || `Дорожка ${i + 1}`;
  }
  function soapActiveAudioLang() {
    const hls = state.hls;
    const track = hls?.audioTracks?.[hls.audioTrack];
    return track?.lang || track?.name || track?.label || "";
  }
  function soapAutoQualityLabel(hls) {
    const index = hls?.loadLevel >= 0 ? hls.loadLevel : hls?.nextLevel >= 0 ? hls.nextLevel : hls?.currentLevel;
    const level = index >= 0 ? hls.levels?.[index] : null;
    const label = qualityLabel(level);
    return label ? `Авто (${label})` : "Авто";
  }
  function soapHlsConfig() {
    return {
      enableWorker: true,
      lowLatencyMode: false,
      startLevel: -1,
      testBandwidth: true,
      capLevelToPlayerSize: true,
      capLevelOnFPSDrop: true,
      maxDevicePixelRatio: 2,
      maxBufferLength: 45,
      maxMaxBufferLength: 90,
      backBufferLength: 60,
      abrEwmaFastVoD: 3,
      abrEwmaSlowVoD: 9,
      abrEwmaDefaultEstimate: initialBandwidthEstimate(5_000_000),
      abrEwmaDefaultEstimateMax: 12_000_000,
      abrBandWidthFactor: 0.88,
      abrBandWidthUpFactor: 0.68,
      maxStarvationDelay: 4,
      maxLoadingDelay: 4,
      manifestLoadingTimeOut: 12_000,
      levelLoadingTimeOut: 12_000,
      fragLoadingTimeOut: 25_000,
      manifestLoadingMaxRetry: 2,
      levelLoadingMaxRetry: 3,
      fragLoadingMaxRetry: 4,
      manifestLoadingRetryDelay: 700,
      levelLoadingRetryDelay: 700,
      fragLoadingRetryDelay: 700,
      manifestLoadingMaxRetryTimeout: 5_000,
      levelLoadingMaxRetryTimeout: 8_000,
      fragLoadingMaxRetryTimeout: 8_000,
      appendErrorMaxRetry: 4,
      preserveManualLevelOnError: false,
    };
  }
  function isExpiredSoapHlsError(data) {
    const code = Number(data?.response?.code || data?.response?.status || data?.networkDetails?.status || 0);
    const details = String(data?.details || "");
    return code === 404 && /manifest|level|playlist/i.test(details);
  }
  function isSoapManifestHlsError(data) {
    return /manifest/i.test(String(data?.details || ""));
  }
  function soapHlsErrorMessage(data) {
    if (isExpiredSoapHlsError(data)) {
      return "SOAP master URL протух. Нужно обновить soap-movies.json свежим дампом.";
    }
    const code = data?.response?.code || data?.response?.status || data?.networkDetails?.status || "";
    if (isSoapManifestHlsError(data)) {
      return `SOAP master URL не загрузился${code ? ` (${code})` : ""}. Проверь свежесть soap-movies.json.`;
    }
    return `HLS: ${data?.details || data?.type || "fatal"}${code ? ` (${code})` : ""}`;
  }

  async function playSoapHls(url, token, opts = {}) {
    if (isStale(token)) return;
    await teardownPlayer();
    resetSubtitleRequest();
    const video = document.createElement("video");
    video.controls = true;
    video.playsInline = true;
    mountPaused(video);
    video.crossOrigin = "anonymous";
    video.playbackRate = state.playbackRate;
    if (isStale(token)) return;
    el.playerHost.replaceChildren(video);
    state.videoEl = video;

    const onReady = () => {
      if (isStale(token)) return;
      if (opts.resume > 5) { try { video.currentTime = opts.resume; } catch { /* ignore */ } }
      video.playbackRate = state.playbackRate;
      renderSoapTracks();
      markPlayerReady();
      startPlaybackIfAllowed(video, { resume: opts.resume > 5 });
    };

    const nativeHls = !!video.canPlayType("application/vnd.apple.mpegurl");
    // iOS has native HLS and no MSE, so downloading hls.js there is pure latency.
    if ((TIZEN_VIDEO_MODE || !window.MediaSource) && nativeHls) {
      video.src = url;
      video.addEventListener("loadedmetadata", onReady, { once: true });
      return;
    }

    // hls.js (Chrome/Firefox/desktop Safari via MSE) — full custom track UI.
    try {
      await ensureHls();
    } catch (error) {
      if (!nativeHls) throw error;
    }
    if (isStale(token)) return;
    if (window.Hls && window.Hls.isSupported()) {
      const hls = new Hls(soapHlsConfig());
      let networkRecoveries = 0;
      let mediaRecoveries = 0;
      state.hls = hls;
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (isStale(token)) return;
        removeSoapHevcLevels(hls);
        hls.currentLevel = -1;
        hls.loadLevel = -1;
        hls.nextLevel = -1;
        if (opts.audioLang && (hls.audioTracks || []).length) {
          const want = String(opts.audioLang).toLowerCase();
          const idx = hls.audioTracks.findIndex((t) => String(t.lang || t.name || "").toLowerCase().startsWith(want));
          if (idx >= 0) {
            if ("nextAudioTrack" in hls) hls.nextAudioTrack = idx;
            hls.audioTrack = idx;
          }
        }
        hls.subtitleDisplay = false;
        hls.subtitleTrack = -1;
        onReady();
      });
      hls.on(Hls.Events.LEVELS_UPDATED, renderSoapTracks);
      hls.on(Hls.Events.LEVEL_SWITCHED, renderSoapTracks);
      hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, renderSoapTracks);
      hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, renderSoapTracks);
      hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, renderSoapTracks);
      hls.on(Hls.Events.SUBTITLE_TRACK_SWITCHED, renderSoapTracks);
      hls.on(Hls.Events.ERROR, (_evt, data) => {
        if (!data?.fatal) return;
        log("soap-hls-error", data.type, data.details);
        if (isExpiredSoapHlsError(data) || isSoapManifestHlsError(data)) {
          if (!isStale(token)) showError(new Error(soapHlsErrorMessage(data)));
          return;
        }
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && networkRecoveries < 3) {
          networkRecoveries += 1;
          setTimeout(() => { if (!isStale(token)) hls.startLoad(-1); }, networkRecoveries * 650);
          return;
        }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries < 2) {
          mediaRecoveries += 1;
          hls.recoverMediaError();
          return;
        }
        if (!isStale(token)) showError(new Error(soapHlsErrorMessage(data)));
      });
      hls.loadSource(url);
      hls.attachMedia(video);
      return;
    }

    // Native HLS (iOS Safari, no MSE) — plays demuxed TS directly; the media
    // element exposes audio/text tracks, quality is auto-managed by the OS.
    if (nativeHls) {
      video.src = url;
      video.addEventListener("loadedmetadata", onReady, { once: true });
      return;
    }
    throw new Error("Браузер не поддерживает HLS");
  }

  function renderSoapTracks() {
    const video = state.videoEl;
    if (!video) return;
    const hls = state.hls;
    el.serialPanel.replaceChildren();
    el.serialPanel.classList.add("hidden");
    el.trackPanel.replaceChildren();
    el.trackPanel.classList.remove("hidden");

    if (hls) {
      const audio = hls.audioTracks || [];
      if (audio.length > 1) {
        addTrackGroup("Озвучка", audio, (t, i) => {
          const btn = document.createElement("button");
          btn.textContent = soapAudioName(t, i);
          if (i === hls.audioTrack) btn.className = "active";
          btn.addEventListener("click", () => {
            if ("nextAudioTrack" in hls) hls.nextAudioTrack = i;
            hls.audioTrack = i;
            const lang = t.lang || t.name || "";
            if (lang) persistAudio(lang);
            setTimeout(renderSoapTracks, 150);
          });
          return btn;
        });
      }
      const seen = new Set();
      const levels = soapAvcLevels(hls).filter((l) => (seen.has(l.height) ? false : seen.add(l.height)));
      addTrackGroup("Качество", [{ auto: true }, ...levels], (l) => {
        const btn = document.createElement("button");
        if (l.auto) {
          btn.textContent = soapAutoQualityLabel(hls);
          if (hls.autoLevelEnabled) btn.className = "active";
          btn.addEventListener("click", () => {
            hls.capLevelToPlayerSize = true;
            hls.currentLevel = -1;
            hls.loadLevel = -1;
            hls.nextLevel = -1;
            setTimeout(renderSoapTracks, 150);
          });
          return btn;
        }
        btn.textContent = `${qualityLabel(l) || "auto"} ${(l.bitrate / 1e6).toFixed(1)} Mbps`;
        if (!hls.autoLevelEnabled && l._i === hls.currentLevel) btn.className = "active";
        btn.addEventListener("click", () => {
          hls.capLevelToPlayerSize = false;
          hls.currentLevel = l._i;
          setTimeout(renderSoapTracks, 150);
        });
        return btn;
      });
      const subs = hls.subtitleTracks || [];
      addTrackGroup("Субтитры", [{ off: true }, ...subs.map((t, i) => ({ t, i }))], (it) => {
        const btn = document.createElement("button");
        if (it.off) {
          btn.textContent = "Выкл";
          if (!hls.subtitleDisplay || hls.subtitleTrack < 0) btn.className = "active";
          btn.addEventListener("click", () => {
            hls.subtitleDisplay = false; hls.subtitleTrack = -1; setTimeout(renderSoapTracks, 100);
          });
          return btn;
        }
        btn.textContent = it.t.name || it.t.lang || `sub ${it.i + 1}`;
        if (hls.subtitleDisplay && it.i === hls.subtitleTrack) btn.className = "active";
        btn.addEventListener("click", () => {
          hls.subtitleTrack = it.i; hls.subtitleDisplay = true; setTimeout(renderSoapTracks, 100);
        });
        return btn;
      });
    } else {
      const atracks = video.audioTracks ? Array.from(video.audioTracks) : [];
      if (atracks.length > 1) {
        addTrackGroup("Озвучка", atracks, (t, i) => {
          const btn = document.createElement("button");
          btn.textContent = soapAudioName(t, i);
          if (t.enabled) btn.className = "active";
          btn.addEventListener("click", () => {
            atracks.forEach((x) => { x.enabled = false; });
            t.enabled = true;
            setTimeout(renderSoapTracks, 100);
          });
          return btn;
        });
      }
      const ttracks = video.textTracks ? Array.from(video.textTracks) : [];
      if (ttracks.length) {
        addTrackGroup("Субтитры", [{ off: true }, ...ttracks.map((t, i) => ({ t, i }))], (it) => {
          const btn = document.createElement("button");
          if (it.off) {
            btn.textContent = "Выкл";
            if (![...ttracks].some((x) => x.mode === "showing")) btn.className = "active";
            btn.addEventListener("click", () => { ttracks.forEach((x) => { x.mode = "disabled"; }); setTimeout(renderSoapTracks, 100); });
            return btn;
          }
          btn.textContent = it.t.label || it.t.language || `sub ${it.i + 1}`;
          if (it.t.mode === "showing") btn.className = "active";
          btn.addEventListener("click", () => {
            ttracks.forEach((x) => { x.mode = "disabled"; });
            it.t.mode = "showing";
            setTimeout(renderSoapTracks, 100);
          });
          return btn;
        });
      }
    }

    addTrackGroup("Скорость", [0.5, 1, 1.25, 1.5, 1.75, 2].map((s) => ({ speed: s })), (item) => {
      const btn = document.createElement("button");
      btn.textContent = `${item.speed}×`;
      if (item.speed === state.playbackRate) btn.className = "active";
      btn.addEventListener("click", () => {
        state.playbackRate = item.speed;
        try { localStorage.setItem("alphy.playbackRate", String(item.speed)); } catch { /* ignore */ }
        if (state.videoEl) state.videoEl.playbackRate = item.speed;
        setTimeout(renderSoapTracks, 50);
      });
      return btn;
    });
  }

  async function playCollaps(kpId, token, opts = {}) {
    const id = String(kpId || "").trim();
    if (!/^\d+$/.test(id)) throw new Error("Collaps: неверный KP id");

    const cachedSeed = opts.meta || cacheGet("meta", id) || cacheGet("metasummary", id);
    const cachedMeta = cachedSeed ? mergeMetadata(cachedSeed, {}) : null;
    const metaTask = metadataIsFull(cachedMeta)
      ? Promise.resolve(cachedMeta)
      : fetchMovieMeta(id).catch(() => null);
    const playlist = await fetchCollapsPlaylist(id);
    if (isStale(token)) return;
    let meta = cachedMeta || await settleWithin(metaTask, 200);
    if (isStale(token)) return;
    if (metadataIsFull(meta)) cacheSet("meta", id, meta, TTL.meta);

    const requested =
      normalizeCollapsSelection(opts.selection) ||
      normalizeCollapsSelection(savedCollapsSelection(`clps:${id}`));
    const title = movieTitle(meta) || playlist.titleName || `KP ${id}`;
    const target = {
      kind: "clps",
      kpId: id,
      title,
      poster: meta?.poster || "",
      year: meta?.year || "",
      isSeries: !!(playlist.isSerial || meta?.isSeries || requested?.season || requested?.episode),
      ...(requested?.season ? { season: requested.season } : {}),
      ...(requested?.episode ? { episode: requested.episode } : {}),
    };
    state.currentTarget = target;
    setWatchHead(title, target);
    renderMeta(mergeMetadata({ title, isSeries: target.isSeries }, meta || {}), target);
    recordOpen(target);

    if (!metadataIsFull(meta)) {
      metaTask.then((fresh) => {
        const current = state.currentTarget;
        if (!fresh || isStale(token) || current?.kind !== "clps" || String(current.kpId || "") !== id) return;
        meta = fresh;
        cacheSet("meta", id, fresh, TTL.meta);
        current.title = movieTitle(fresh) || current.title;
        current.poster = fresh.poster || current.poster;
        current.year = fresh.year || current.year;
        current.isSeries = !!(playlist.isSerial || fresh.isSeries || current.isSeries);
        setWatchHead(current.title || `KP ${id}`, current);
        renderMeta(mergeMetadata({ title: current.title, isSeries: current.isSeries }, fresh), current);
        recordOpen(current);
      }).catch(() => {});
    }

    const context = buildCollapsContext(playlist);
    const selection = chooseCollapsSelection(context, requested);
    if (!selection) throw new Error("Collaps не вернул озвучки/серии для этого KP");
    await playCollapsSelection(context, selection, token, resumePosition(keyFor(target)), {
      qualityKey: requested?.qualityKey,
    });
  }

  async function playCollapsSelection(context, selection, token, resume = 0, opts = {}) {
    const target = state.currentTarget;
    if (!target || target.kind !== "clps") return;
    const picked = chooseCollapsSelection(context, selection);
    const item = picked?.item;
    if (!item?.vkId) throw new Error("Collaps: не выбрана озвучка");

    const resolved = await fetchCollapsVideo(item.vkId);
    if (isStale(token)) return;
    if (!resolved.sources.length) throw new Error("Collaps не отдал progressive MP4");

    const stored = normalizeCollapsSelection(savedCollapsSelection(keyFor(target))) || {};
    const source = chooseCollapsSource(
      resolved.sources,
      opts.qualityKey || selection?.qualityKey || stored.qualityKey,
    );
    if (!source?.url) throw new Error("Collaps: нет выбранного качества");

    const nextSelection = cleanCollapsSelection({
      ...picked,
      qualityKey: source.key,
    });
    if (nextSelection.season) target.season = nextSelection.season;
    if (nextSelection.episode) target.episode = nextSelection.episode;

    const previous = state.collaps || {};
    const playback = {
      context,
      selection: nextSelection,
      item,
      sources: resolved.sources,
      videoMeta: resolved.raw || {},
      qualityKey: source.key,
      autoRefresh: opts.autoRefresh ?? previous.autoRefresh ?? true,
      refreshSec: opts.refreshSec || previous.refreshSec || COLLAPS_REFRESH_SEC,
      activeIndex: 0,
      videos: [],
      refreshTimer: null,
      uiTimer: null,
      watchdog: null,
      lastAdvanceWall: Date.now(),
      nextAt: 0,
      pendingRefresh: false,
      refreshing: false,
      nativeFullscreenVideo: null,
      fullscreenButton: null,
      status: "",
    };
    state.collaps = playback;
    persistCollapsSelection(target, nextSelection, resume);
    await mountCollapsMp4(source.url, token, resume);
    if (state.collaps !== playback) return;
    if (isStale(token)) return;
    renderCollapsControls();
    startTracking(keyFor(target), target);
  }

  async function mountCollapsMp4(url, token, resume = 0) {
    const c = state.collaps;
    if (!c || isStale(token)) return;
    stopCollapsTimers();
    warmCollapsConnections(url);

    const active = createCollapsVideo();
    const buffer = createCollapsVideo();
    active.dataset.collapsActive = "1";
    buffer.dataset.collapsActive = "0";
    c.videos = [active, buffer];
    c.activeIndex = 0;
    state.videoEl = active;
    el.playerHost.classList.add("collaps-host");
    el.playerHost.replaceChildren(active, buffer);
    mountCollapsFullscreenButton();

    await new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        active.removeEventListener("canplay", done);
        active.removeEventListener("loadedmetadata", onMeta);
        if (!isStale(token) && state.collaps === c) markPlayerReady();
        resolve();
      };
      const onMeta = () => {
        if (resume > 5) { try { active.currentTime = resume; } catch { /* ignore */ } }
      };
      active.addEventListener("loadedmetadata", onMeta);
      active.addEventListener("canplay", done);
      active.src = url;
      active.load();
      startPlaybackIfAllowed(active, { resume: resume > 5 });
      setTimeout(done, 2500);
    });
    bindCollapsActive();
    armCollapsTimers();
  }

  function createCollapsVideo() {
    const video = document.createElement("video");
    video.controls = true;
    video.playsInline = true;
    video.referrerPolicy = "no-referrer";
    // The native fullscreen button binds fullscreen to this replaceable <video>.
    // Hide it where controlsList is supported and provide our own button on the
    // stable #playerHost instead. Browsers that ignore this are still protected:
    // native video fullscreen is detected and automatic swaps are deferred.
    video.setAttribute("controlslist", "nofullscreen noremoteplayback");
    try {
      video.controlsList?.add("nofullscreen");
      video.controlsList?.add("noremoteplayback");
      video.disableRemotePlayback = true;
    } catch { /* optional media-control hints */ }
    mountPaused(video);
    video.playbackRate = state.playbackRate;
    return video;
  }

  function mountCollapsFullscreenButton() {
    const c = state.collaps;
    if (!c || !el.playerHost) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "collaps-fullscreen-btn";
    btn.setAttribute("aria-label", "Полный экран");
    btn.setAttribute("title", "Полный экран");
    btn.textContent = "⛶";
    btn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleFullscreen();
    });
    c.fullscreenButton = btn;
    el.playerHost.appendChild(btn);
  }

  function isCollapsNativeFullscreen(video = activeCollapsVideo()) {
    const c = state.collaps;
    if (!c || !video) return false;
    return document.fullscreenElement === video ||
      video.webkitDisplayingFullscreen === true ||
      c.nativeFullscreenVideo === video;
  }

  function resumePendingCollapsRefresh(reason = "выход из fullscreen") {
    const c = state.collaps;
    if (!c || !c.pendingRefresh || c.refreshing || isCollapsNativeFullscreen()) return;
    c.pendingRefresh = false;
    refreshCollapsNow(reason).catch((error) => log("collaps-refresh-warn", error.message));
  }

  function waitForCollapsSeek(video, target, timeoutMs = 3000) {
    if (!video || !Number.isFinite(target)) return Promise.resolve(false);
    if (Math.abs((video.currentTime || 0) - target) < 0.18) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        video.removeEventListener("seeked", onSeeked);
        video.removeEventListener("error", onError);
        resolve(ok);
      };
      const onSeeked = () => finish(true);
      const onError = () => finish(false);
      const timer = setTimeout(() => finish(false), timeoutMs);
      video.addEventListener("seeked", onSeeked);
      video.addEventListener("error", onError);
      try { video.currentTime = Math.max(0, target); }
      catch { finish(false); }
    });
  }

  // timeupdate means the media clock advanced; it does NOT mean the new frame
  // reached the compositor. requestVideoFrameCallback is the correct handoff
  // signal. Older engines fall back to timeupdate plus two animation frames.
  function waitForPresentedCollapsFrame(video, timeoutMs = 3500) {
    if (!video) return Promise.resolve(false);
    return new Promise((resolve) => {
      let done = false;
      let frameId = null;
      const finish = (ok) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        video.removeEventListener("timeupdate", onTime);
        if (frameId != null) {
          try { video.cancelVideoFrameCallback?.(frameId); } catch { /* ignore */ }
        }
        resolve(ok);
      };
      const afterPaint = () => {
        const raf = window.requestAnimationFrame || ((fn) => setTimeout(fn, 16));
        raf(() => raf(() => finish(true)));
      };
      const onTime = () => afterPaint();
      const timer = setTimeout(() => finish(false), timeoutMs);
      if (typeof video.requestVideoFrameCallback === "function") {
        frameId = video.requestVideoFrameCallback(() => finish(true));
      } else {
        video.addEventListener("timeupdate", onTime, { once: true });
      }
    });
  }

  function activeCollapsVideo() {
    const c = state.collaps;
    return c?.videos?.[c.activeIndex] || state.videoEl;
  }

  function bufferCollapsVideo() {
    const c = state.collaps;
    if (!c?.videos?.length) return null;
    return c.videos[c.activeIndex === 0 ? 1 : 0];
  }

  function bindCollapsActive() {
    const c = state.collaps;
    const active = activeCollapsVideo();
    const buffer = bufferCollapsVideo();
    if (!c || !active) return;
    if (buffer) {
      buffer.onerror = null;
      buffer.ontimeupdate = null;
      buffer.oncanplay = null;
      buffer.onplay = null;
      buffer.onwebkitbeginfullscreen = null;
      buffer.onwebkitendfullscreen = null;
    }
    active.ontimeupdate = () => { c.lastAdvanceWall = Date.now(); };
    active.onplay = () => {
      if (c.pendingRefresh && !c.refreshing && !isCollapsNativeFullscreen(active)) {
        c.pendingRefresh = false;
        refreshCollapsNow("возобновление").catch((error) => log("collaps-refresh-warn", error.message));
      }
    };
    active.onwebkitbeginfullscreen = () => {
      if (state.collaps === c) c.nativeFullscreenVideo = active;
    };
    active.onwebkitendfullscreen = () => {
      if (state.collaps !== c) return;
      if (c.nativeFullscreenVideo === active) c.nativeFullscreenVideo = null;
      resumePendingCollapsRefresh();
    };
    active.onerror = () => {
      if (!c.refreshing) {
        refreshCollapsNow("error").catch((error) => showError(new Error("Collaps: " + error.message)));
      }
    };
  }

  async function resolveFreshCollapsSource(qualityKey = "") {
    const c = state.collaps;
    if (!c?.item?.vkId) return null;
    const resolved = await fetchCollapsVideo(c.item.vkId, { force: true });
    if (state.collaps !== c) return null;
    if (!resolved.sources.length) return null;
    const source = chooseCollapsSource(resolved.sources, qualityKey || c.qualityKey);
    c.sources = resolved.sources;
    c.videoMeta = resolved.raw || {};
    c.qualityKey = source.key;
    c.selection = cleanCollapsSelection({ ...c.selection, qualityKey: source.key });
    if (state.currentTarget) persistCollapsSelection(state.currentTarget, c.selection, activeCollapsVideo()?.currentTime || 0);
    return source.url;
  }

  async function refreshCollapsNow(reason, qualityKey = "") {
    const c = state.collaps;
    if (!c || c.refreshing) return;

    const current = activeCollapsVideo();
    const emergency = reason === "error" || reason === "зависание";
    // A native fullscreen session belongs to the exact <video> element. Never
    // replace that element under a healthy viewer. Automatic refresh waits until
    // fullscreen ends; only an actual playback failure or an explicit quality
    // choice may reload the same element in place.
    if (isCollapsNativeFullscreen(current) && !emergency && !qualityKey) {
      c.pendingRefresh = true;
      armCollapsTimers();
      log("collaps-refresh-deferred", "native video fullscreen");
      return;
    }

    c.refreshing = true;
    stopCollapsSchedule();
    try {
      const url = await resolveFreshCollapsSource(qualityKey);
      if (!url) throw new Error("не удалось получить свежий MP4");
      warmCollapsConnections(url);

      if (isCollapsNativeFullscreen(activeCollapsVideo())) {
        // Keep the fullscreen-owned DOM node alive. A stalled stream may show a
        // short provider rebuffer, but it cannot expose the site UI or strand
        // fullscreen on a hidden element.
        hardReloadCollapsVideo(url);
      } else {
        const ok = await swapCollapsVideo(url);
        if (!ok) {
          const video = activeCollapsVideo();
          const stalled = !video || video.error || video.ended
            || (!video.paused && video.readyState < 3)
            || qualityKey;
          if (stalled) hardReloadCollapsVideo(url);
          else log("collaps-refresh-deferred", "подмена не удалась, картинка идёт — ждём следующей попытки");
        }
      }
      c.lastAdvanceWall = Date.now();
    } finally {
      c.refreshing = false;
      armCollapsTimers();
      renderCollapsControls();
      log("collaps-refresh", reason);
    }
  }

  function swapCollapsVideo(url) {
    const c = state.collaps;
    const cur = activeCollapsVideo();
    const next = bufferCollapsVideo();
    if (!c || !cur || !next || isCollapsNativeFullscreen(cur)) return Promise.resolve(false);

    return new Promise((resolve) => {
      const wasPlaying = !cur.paused && !cur.ended;
      const desiredMuted = !!cur.muted;
      const desiredVolume = Number.isFinite(cur.volume) ? cur.volume : 1;
      let done = false;
      let preparing = false;

      const cleanup = () => {
        next.removeEventListener("loadedmetadata", onMeta);
        next.removeEventListener("canplay", onCan);
        next.removeEventListener("error", onErr);
        clearTimeout(guard);
      };
      const finish = (ok) => {
        if (done) return;
        done = true;
        cleanup();
        if (!ok) {
          try {
            next.pause();
            next.dataset.collapsActive = "0";
            next.style.opacity = "0";
            next.style.pointerEvents = "none";
            next.removeAttribute("src");
            next.load();
          } catch { /* ignore */ }
          if (wasPlaying && cur.paused) cur.play().catch(() => {});
        }
        resolve(ok);
      };
      const guard = setTimeout(() => finish(false), 14000);

      const lateSync = async () => {
        const target = cur.currentTime || 0;
        if (!(await waitForCollapsSeek(next, target))) return false;
        if (wasPlaying) {
          try { await next.play(); }
          catch { return false; }
        }
        if (!(await waitForPresentedCollapsFrame(next))) return false;

        // The outgoing video kept advancing while the spare decoded. If we need
        // a final correction, wait for a frame AFTER that seek too. The previous
        // implementation sought here and revealed immediately, which is exactly
        // how audio can continue over a black compositor frame.
        const drift = (cur.currentTime || 0) - (next.currentTime || 0);
        if (Math.abs(drift) > 0.35) {
          if (!(await waitForCollapsSeek(next, cur.currentTime || 0))) return false;
          if (!(await waitForPresentedCollapsFrame(next))) return false;
        }
        return true;
      };

      const reveal = () => {
        if (state.collaps !== c || isCollapsNativeFullscreen(cur)) { finish(false); return; }

        // Both decoded layers overlap for the handoff. There is never a frame in
        // which the old layer is gone and the new layer has not been composited.
        next.dataset.collapsActive = "1";
        next.style.zIndex = "2";
        next.style.opacity = "1";
        next.style.pointerEvents = "auto";
        cur.style.zIndex = "1";

        // Audio changes owner without a double-audio interval.
        cur.muted = true;
        next.volume = desiredVolume;
        next.muted = desiredMuted;

        c.activeIndex = c.activeIndex === 0 ? 1 : 0;
        state.videoEl = next;
        bindCollapsActive();

        const raf = window.requestAnimationFrame || ((fn) => setTimeout(fn, 16));
        raf(() => raf(() => {
          if (state.collaps !== c) { finish(false); return; }
          try { cur.pause(); } catch { /* ignore */ }
          cur.dataset.collapsActive = "0";
          cur.style.opacity = "0";
          cur.style.pointerEvents = "none";
          cur.style.zIndex = "0";
          cur.muted = desiredMuted;
          next.style.zIndex = "1";
          setTimeout(() => {
            try { cur.removeAttribute("src"); cur.load(); } catch { /* ignore */ }
          }, 250);
          finish(true);
        }));
      };

      const onMeta = () => {
        try { next.currentTime = Math.max(0, cur.currentTime || 0); } catch { /* ignore */ }
      };
      const onCan = async () => {
        if (preparing || done) return;
        preparing = true;
        next.removeEventListener("canplay", onCan);
        if (state.collaps !== c) { finish(false); return; }
        next.playbackRate = cur.playbackRate;
        // Preserve the viewer's mute state, but prime with zero audio output so
        // the spare can play without a double-audio interval. At reveal() volume
        // moves from old -> new atomically; there is no late unmute transition.
        next.muted = desiredMuted;
        next.volume = 0;
        if (!(await lateSync())) { finish(false); return; }
        reveal();
      };
      const onErr = () => finish(false);

      next.dataset.collapsActive = "0";
      next.style.opacity = "0";
      next.style.pointerEvents = "none";
      next.style.zIndex = "0";
      next.muted = desiredMuted;
      next.volume = 0;
      next.preload = "auto";
      next.addEventListener("loadedmetadata", onMeta);
      next.addEventListener("canplay", onCan);
      next.addEventListener("error", onErr);
      next.src = url;
      next.load();
    });
  }

  function hardReloadCollapsVideo(url) {
    const video = activeCollapsVideo();
    if (!video) return;
    const position = video.currentTime || 0;
    const wasPlaying = !video.paused && !video.ended;
    video.src = url;
    video.load();
    video.addEventListener("loadedmetadata", function once() {
      video.removeEventListener("loadedmetadata", once);
      if (position > 0) { try { video.currentTime = position; } catch { /* ignore */ } }
      if (wasPlaying) video.play().catch(() => {});
    });
  }

  function stopCollapsSchedule() {
    const c = state.collaps;
    if (!c) return;
    clearTimeout(c.refreshTimer);
    clearInterval(c.uiTimer);
    c.refreshTimer = null;
    c.uiTimer = null;
  }

  function stopCollapsTimers() {
    const c = state.collaps;
    if (!c) return;
    stopCollapsSchedule();
    clearInterval(c.watchdog);
    c.watchdog = null;
  }

  function armCollapsTimers() {
    const c = state.collaps;
    if (!c) return;
    stopCollapsSchedule();
    if (!c.autoRefresh) {
      ensureCollapsWatchdog();
      return;
    }
    const delay = Math.round(c.refreshSec * 1000 * (0.85 + Math.random() * 0.3));
    c.nextAt = Date.now() + delay;
    c.refreshTimer = setTimeout(() => {
      const video = activeCollapsVideo();
      if (video && !video.paused && !video.ended) {
        refreshCollapsNow("таймер").catch((error) => log("collaps-refresh-warn", error.message));
      } else {
        c.pendingRefresh = true;
        armCollapsTimers();
      }
    }, delay);
    ensureCollapsWatchdog();
  }

  function ensureCollapsWatchdog() {
    const c = state.collaps;
    if (!c || c.watchdog) return;
    c.watchdog = setInterval(() => {
      if (!c.autoRefresh || c.refreshing) return;
      const video = activeCollapsVideo();
      if (!video || video.paused || video.ended || video.readyState < 2) return;
      if (Date.now() - (c.lastAdvanceWall || 0) > 8000) {
        refreshCollapsNow("зависание").catch((error) => log("collaps-refresh-warn", error.message));
      }
    }, 2000);
  }

  function teardownCollapsPlayer() {
    const c = state.collaps;
    if (!c) return;
    stopCollapsTimers();
    for (const video of c.videos || []) {
      try {
        video.pause();
        video.removeAttribute("src");
        video.load();
      } catch {
        /* ignore */
      }
    }
    el.playerHost.classList.remove("collaps-host");
    state.collaps = null;
  }

  function renderCollapsControls() {
    const c = state.collaps;
    if (!c) return;
    el.serialPanel.replaceChildren();
    el.serialPanel.classList.add("hidden");
    el.trackPanel.replaceChildren();
    el.trackPanel.classList.remove("hidden");

    if (c.context.isSerial) renderCollapsSerialControls(c.context, c.selection);

    const voices = collapsVoicesForSelection(c.context, c.selection);
    addTrackGroup("Озвучка", voices, (item, index) => {
      const btn = document.createElement("button");
      btn.textContent = collapsVoiceLabel(item, index);
      if (item.vkId === c.selection.vkId) btn.className = "active";
      btn.addEventListener("click", () => switchCollapsSelection({
        ...c.selection,
        voiceIndex: index,
        vkId: item.vkId,
        voiceName: collapsVoiceLabel(item, index),
      }));
      return btn;
    });

    addTrackGroup("Качество", c.sources || [], (source) => {
      const btn = document.createElement("button");
      btn.textContent = source.label;
      if (source.key === c.qualityKey) btn.className = "active";
      btn.addEventListener("click", () => refreshCollapsNow("качество", source.key).catch((error) => showError(error)));
      return btn;
    });

    addTrackGroup("Скорость", [0.5, 1, 1.25, 1.5, 1.75, 2].map((speed) => ({ speed })), (item) => {
      const btn = document.createElement("button");
      btn.textContent = `${item.speed}×`;
      if (item.speed === state.playbackRate) btn.className = "active";
      btn.addEventListener("click", () => {
        state.playbackRate = item.speed;
        try { localStorage.setItem("alphy.playbackRate", String(item.speed)); } catch { /* ignore */ }
        for (const video of c.videos || []) video.playbackRate = item.speed;
        setTimeout(renderCollapsControls, 50);
      });
      return btn;
    });
  }

  function renderCollapsSerialControls(context, selection) {
    const current = chooseCollapsSelection(context, selection);
    const season = context.seasons.find((item) => item.season === current?.season);

    addTrackGroup("", context.seasons, (item) => {
      const btn = document.createElement("button");
      btn.textContent = `Сезон ${item.season}`;
      if (item.season === current?.season) btn.className = "active";
      btn.addEventListener("click", () => {
        const preferred = item.episodes.find((episode) => episode.episode === current?.episode) || item.episodes[0];
        switchCollapsSelection({
          season: item.season,
          episode: preferred?.episode,
          vkId: current?.vkId,
          voiceName: current?.voiceName,
          qualityKey: current?.qualityKey,
        });
      });
      return btn;
    }, { panel: el.serialPanel, hideLabel: true, className: "serial-seasons" });

    addTrackGroup("", season?.episodes || [], (item) => {
      const btn = document.createElement("button");
      btn.textContent = String(item.episode);
      if (item.episode === current?.episode) btn.className = "active";
      btn.addEventListener("click", () => {
        switchCollapsSelection({
          season: current?.season,
          episode: item.episode,
          vkId: current?.vkId,
          voiceName: current?.voiceName,
          qualityKey: current?.qualityKey,
        });
      });
      return btn;
    }, { panel: el.serialPanel, hideLabel: true, className: "serial-episodes" });
  }

  async function switchCollapsSelection(nextSelection) {
    const c = state.collaps;
    const target = state.currentTarget;
    if (!c || !target || target.kind !== "clps") return;
    const next = chooseCollapsSelection(c.context, nextSelection);
    if (!next || sameCollapsSelection(c.selection, next)) return;
    const token = resolveToken;
    const context = c.context;
    const autoRefresh = c.autoRefresh;
    const refreshSec = c.refreshSec;
    const qualityKey = c.qualityKey;
    teardownCollapsPlayer();
    showPlayerLoading();
    try {
      await playCollapsSelection(context, next, token, 0, { qualityKey, autoRefresh, refreshSec });
    } catch (error) {
      if (!isStale(token)) showError(new Error(`Collaps: ${error.message}`));
    }
  }

  function persistCollapsSelection(target, selection, position = 0) {
    if (!target || target.kind !== "clps") return;
    recordHistory({
      key: keyFor(target),
      kind: target.kind,
      target: cleanTarget(target),
      title: target.title || "",
      poster: target.poster || "",
      year: target.year || "",
      collapsSelection: cleanCollapsSelection(selection),
      position,
      duration: 0,
      progress: 0,
    });
  }

  function settleWithin(promise, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      promise.then(
        (value) => { clearTimeout(timer); resolve(value); },
        (error) => { clearTimeout(timer); reject(error); },
      );
    });
  }

  function firstAvailable(promises) {
    const jobs = (promises || []).filter(Boolean);
    if (!jobs.length) return Promise.resolve(null);
    return new Promise((resolve) => {
      let remaining = jobs.length;
      let done = false;
      const settle = (value) => {
        if (done) return;
        if (value) {
          done = true;
          resolve(value);
          return;
        }
        remaining -= 1;
        if (!remaining) {
          done = true;
          resolve(null);
        }
      };
      jobs.forEach((job) => Promise.resolve(job).then(settle, () => settle(null)));
    });
  }

  async function resolveStandardKpPlaybackSource(kpId, meta, selection, shouldContinue = () => true) {
    const cachedZona = cacheGet("zona", kpId);
    // A mid-watch Zenith title keeps its player: resume position and озвучка
    // live under the kp: history key and do not transfer to Collaps.
    if (cachedZona?.embedUrl && resumePosition(`kp:${kpId}`) > 0) {
      return { kind: "zen", resolved: cachedZona };
    }
    const cachedLiftId = cacheGet(LIFTW_BY_KP_CACHE_NS, String(kpId));
    if (typeof cachedLiftId === "string" && cachedLiftId) return { kind: "lift", liftId: cachedLiftId };
    const cachedCollaps = cacheGet("clpsprobe", kpId);
    if (cachedCollaps?.kpId) return { kind: "clps", hit: cachedCollaps };
    if (cachedZona?.embedUrl) return { kind: "zen", resolved: cachedZona };

    if (!collapsPreviewOnCooldown()) {
      try {
        const hit = await settleWithin(probeCollapsMovie({
          ...(meta || {}),
          kpId: String(kpId),
          title: movieTitle(meta),
          selection,
          rank: 0,
        }), COLLAPS_FAST_PATH_TIMEOUT_MS);
        if (hit?.kpId) return { kind: "clps", hit };
      } catch (error) {
        if (shouldCooldownCollapsPreview(error)) setCollapsPreviewCooldown(error);
        log("collaps-fast-path-warn", { kpId, message: error.message });
      }
    }

    if (!shouldContinue()) return null;
    // Loading the player library overlaps the only server-side stage. If Zona is
    // cold, its several seconds are now useful work instead of dead spinner time.
    ensureShaka().catch((error) => log("shaka-preload-warn", error.message));
    return { kind: "zen", resolved: await resolveZona(kpId) };
  }

  async function resolveKpPlaybackSource(kpId, meta, selection) {
    const recommendation = recommendationContextByKp.get(String(kpId));
    if (!recommendation) return resolveStandardKpPlaybackSource(kpId, meta, selection);

    const warmLiftId = cacheGet(LIFTW_BY_KP_CACHE_NS, String(kpId));
    if (typeof warmLiftId === "string" && warmLiftId) return { kind: "lift", liftId: warmLiftId };

    let selected = false;
    const browserTask = resolveRecommendationPlaybackSource(recommendation, selection);
    const standardTask = resolveStandardKpPlaybackSource(kpId, meta, selection, () => !selected);
    // Start Zona/Collaps immediately, but give client-only sources a bounded lead.
    // This prevents an old cached Zona URL from beating an exact LiftW 1080p hit,
    // while a genuine browser miss adds at most 650 ms and wastes no overlap.
    const browserFast = await settleWithin(browserTask, 650).catch(() => null);
    if (browserFast) {
      selected = true;
      return browserFast;
    }
    const source = await firstAvailable([browserTask, standardTask]);
    selected = !!source;
    return source;
  }

  async function playKp(kpId, token, opts = {}) {
    const id = String(kpId || "");
    const cachedSeed = opts.meta || cacheGet("meta", id) || cacheGet("metasummary", id);
    let meta = cachedSeed ? mergeMetadata(cachedSeed, {}) : null;
    const metaTask = metadataIsFull(meta)
      ? Promise.resolve(meta)
      : fetchMovieMeta(id).catch(() => null);
    const requestedSelection = normalizeSerialHint(opts.serialSelection)
      || normalizeSerialHint(savedSerialSelection(`kp:${id}`));
    const sourceTask = resolveKpPlaybackSource(id, meta, requestedSelection);
    sourceTask.catch(() => {});

    // Metadata must never serialize in front of source resolution. Give a cold
    // direct link a tiny window for a real title, then let playback continue and
    // paint metadata whenever it arrives.
    if (!movieTitle(meta) && !meta.poster) meta = await settleWithin(metaTask, 250) || meta;
    if (isStale(token)) return;
    if (metadataIsFull(meta)) cacheSet("meta", id, meta, TTL.meta);
    const isSeries = !!(opts.forceSeries || meta?.isSeries || requestedSelection);
    const target = {
      kind: "kp",
      kpId: id,
      title: movieTitle(meta),
      poster: meta?.poster,
      year: meta?.year,
      isSeries,
    };
    state.currentTarget = target;
    setWatchHead(target.title || `kpId ${kpId}`, target);
    renderMeta(meta, target);
    recordOpen(target);

    if (!metadataIsFull(meta)) {
      metaTask.then((fresh) => {
        const current = state.currentTarget;
        if (!fresh || isStale(token) || String(current?.kpId || "") !== id) return;
        meta = fresh;
        cacheSet("meta", id, fresh, TTL.meta);
        current.title = movieTitle(fresh) || current.title;
        current.poster = fresh.poster || current.poster;
        current.year = fresh.year || current.year;
        current.isSeries = !!(opts.forceSeries || fresh.isSeries || requestedSelection || current.isSeries);
        setWatchHead(current.title || `kpId ${id}`, current);
        renderMeta(fresh, current);
        recordOpen(current);
      }).catch(() => {});
    }

    // Collaps -> Zona/Zenith, then HDRezka as the last resort. Any failure in the
    // whole chain (cold Zona resolve, Collaps play error whose Zona fallback also
    // failed, or a Zenith embed with no sources) drops into the catch, which tries
    // HDRezka before letting the original, more familiar error surface.
    try {
      let source = await sourceTask;
      if (isStale(token)) return;
      if (!source) throw new Error("Источники не вернули плеер");

      if (source.kind === "ort") {
        try {
          const embedUrl = source.target.embedUrl;
          cacheSet("ortmeta", embedUrl, { ...(meta || {}), kpId: id }, TTL.enriched);
          await playOrt(embedUrl, token, { ...(meta || {}), kpId: id });
          if (!isStale(token)) replaceHash(hashFor(state.currentTarget));
          return;
        } catch (error) {
          if (isStale(token)) return;
          log("ortified-recommend-fallback", { kpId: id, message: error.message });
          showPlayerLoading();
          const recommendation = recommendationContextByKp.get(id);
          const liftwFallback = recommendation
            ? findLiftwByKpId(id, recommendationLiftwHints(recommendation))
              .then((liftId) => liftId ? { kind: "lift", liftId } : null)
            : null;
          source = await firstAvailable([
            liftwFallback,
            resolveStandardKpPlaybackSource(id, meta, requestedSelection),
          ]);
          if (!source || isStale(token)) throw error;
        }
      }

      if (source.kind === "lift") {
        try {
          await playLiftw(source.liftId, token, {
            meta: { ...(meta || {}), kpId: id },
            serialSelection: requestedSelection,
            resume: resumePosition(`kp:${id}`),
            audioPreference: opts.audioPreference,
            subtitlePreference: opts.subtitlePreference,
          });
          if (!isStale(token)) replaceHash(hashFor(state.currentTarget));
          return;
        } catch (error) {
          if (isStale(token)) return;
          log("liftw-recommend-fallback", { kpId: id, message: error.message });
          showPlayerLoading();
          source = await resolveStandardKpPlaybackSource(id, meta, requestedSelection);
          if (!source || isStale(token)) throw error;
        }
      }

      if (source.kind === "clps") {
        try {
          await playCollaps(id, token, { meta, selection: requestedSelection || source.hit.selection });
          if (!isStale(token)) replaceHash(hashFor(state.currentTarget));
          return;
        } catch (error) {
          if (isStale(token)) return;
          log("collaps-fast-path-fallback", { kpId: id, message: error.message });
          showPlayerLoading();
          state.currentTarget = target;
          setWatchHead(target.title || `kpId ${id}`, target);
          if (meta) renderMeta(meta, target);
          ensureShaka().catch(() => {});
          const recommendation = recommendationContextByKp.get(id);
          const liftwFallback = recommendation
            ? findLiftwByKpId(id, recommendationLiftwHints(recommendation))
              .then((liftId) => liftId ? { kind: "lift", liftId } : null)
            : null;
          source = await firstAvailable([
            liftwFallback,
            resolveZona(id).then((resolved) => ({ kind: "zen", resolved })),
          ]);
          if (isStale(token)) return;
        }
      }

      if (source.kind === "lift") {
        try {
          await playLiftw(source.liftId, token, {
            meta: { ...(meta || {}), kpId: id },
            serialSelection: requestedSelection,
            resume: resumePosition(`kp:${id}`),
            audioPreference: opts.audioPreference,
            subtitlePreference: opts.subtitlePreference,
          });
          if (!isStale(token)) replaceHash(hashFor(state.currentTarget));
          return;
        } catch (error) {
          if (isStale(token)) return;
          log("liftw-after-collaps-fallback", { kpId: id, message: error.message });
          showPlayerLoading();
          source = { kind: "zen", resolved: await resolveZona(id) };
          if (isStale(token)) return;
        }
      }

      const resolved = source.resolved;
      if (resolved.zenithId) {
        cacheSet("curatedmeta", `zen:${resolved.zenithId}`, {
          ...(meta || {}),
          title: target.title,
          poster: target.poster,
          year: target.year,
          isSeries: target.isSeries,
          kpId: id,
        }, TTL.enriched);
        replaceHash(`/watch/zen/${encodeURIComponent(resolved.zenithId)}`);
      }
      await playZenithEmbed(resolved.embedUrl, target, token, {
        histKey: `kp:${id}`,
        resume: resumePosition(`kp:${id}`),
        audioPreference: opts.audioPreference,
        subtitlePreference: opts.subtitlePreference,
        serialSelection: requestedSelection,
        forceSeries: target.isSeries,
      });
    } catch (error) {
      if (isStale(token)) return;
      log("kp-sources-exhausted", { kpId: id, message: error.message });
      showPlayerLoading();
      state.currentTarget = target;
      setWatchHead(target.title || `kpId ${id}`, target);
      if (meta) renderMeta(meta, target);
      replaceHash(`/watch/kp/${encodeURIComponent(id)}`);
      const fallbackOpts = {
        kpId: id,
        histKey: `kp:${id}`,
        resume: resumePosition(`kp:${id}`),
        serialSelection: requestedSelection,
      };
      const played = await tryLiftwLastResort(target, meta, token, fallbackOpts)
        || await tryRezkaLastResort(target, meta, token, fallbackOpts);
      if (!played && !isStale(token)) throw error;
    }
  }

  async function playZen(zenithId, token) {
    const cachedMeta = cacheGet("curatedmeta", `zen:${zenithId}`) || storedMeta(`zen:${zenithId}`);
    const target = {
      kind: "zen",
      zenithId,
      title: cachedMeta?.title || `Zenith ${zenithId}`,
      poster: cachedMeta?.poster,
      year: cachedMeta?.year,
      isSeries: !!cachedMeta?.isSeries,
      kpId: validHistoryKpId(cachedMeta?.kpId),
    };
    state.currentTarget = target;
    setWatchHead(target.title, target);
    if (cachedMeta) renderMeta(cachedMeta, target);
    else el.metaPanel.classList.add("hidden");
    recordOpen(target);
    // A deep link to a curated zen: title (a shared URL, a bookmark, a reopened
    // tab) arrives with no cached meta, and used to render as a bare
    // "Zenith <id>" with no sidebar — and therefore no credits and no «Похожее».
    // ort:/opr: already healed from the catalog; zen: was simply missing it.
    if (!cachedMeta?.title || !cachedMeta?.poster) {
      healWatchMeta(target, token, cachedMeta, "curatedmeta", `zen:${zenithId}`, `Zenith ${zenithId}`);
    }
    const embedUrl = `https://api.zenithjs.ws/embed/movie/${encodeURIComponent(zenithId)}`;
    await playZenithEmbed(embedUrl, target, token, {
      histKey: `zen:${zenithId}`,
      resume: resumePosition(`zen:${zenithId}`),
      serialSelection: savedSerialSelection(keyFor(target)),
    });
  }

  async function playOrt(embedUrl, token, ndMeta) {
    // ndMeta is only present on the first resolve (search -> newdeaf -> ortified).
    // On reopen (Continue/Bookmarks/direct URL) recover it from the persisted
    // newdeaf meta, then from the history/bookmark entry, so the sidebar + title
    // look the same as right after search instead of a bare "Ortified" player.
    const meta = ndMeta || cacheGet("ortmeta", embedUrl) || storedMeta(`ort:${embedUrl}`);
    const target = {
      kind: "ort", embedUrl, title: meta?.title, poster: meta?.poster, year: meta?.year,
      kpId: validHistoryKpId(meta?.kpId), isSeries: !!meta?.isSeries,
    };
    state.currentTarget = target;
    setWatchHead(target.title || "Ortified", target);
    if (meta && (meta.title || meta.poster || meta.description)) {
      renderMeta(meta, target);
    } else {
      el.metaPanel.classList.add("hidden");
    }
    recordOpen(target);
    if (!meta || !meta.title || !meta.description || !meta.rating) {
      healWatchMeta(target, token, meta, "ortmeta", embedUrl, "Ortified");
    }
    try {
      await playOrtifiedNative(embedUrl, target, token, {
        histKey: keyFor(target),
        serialSelection: savedSerialSelection(keyFor(target)),
      });
      return;
    } catch (error) {
      if (isStale(token)) return;
      // A non-Russian address gets 422 from api.ortified.ws — usually a VPN left
      // on. That is actionable and must not be buried under a retry that will
      // fail the same way.
      if (/\b422\b/.test(String(error?.message || error))) {
        throw new Error("Попробуйте выключить VPN");
      }
      // Anything else: the embedded player is still a working way to watch, so
      // a title we cannot parse falls back rather than failing.
      log("ort-native-fallback", error.message);
    }
    await playOrtifiedCleanroom(embedUrl, target, token);
  }

  async function playOpr(playerUrl, token, ndMeta) {
    const shakaTask = ensureShaka();
    shakaTask.catch(() => {});
    const meta = ndMeta || cacheGet("oprmeta", playerUrl) || storedMeta(`opr:${playerUrl}`);
    const pageUrl = meta?.pageUrl || "";
    const serialHint = normalizeSerialHint(meta?.serialSelection) ||
      newdeafSerialHint(meta?.title || "", pageUrl, playerUrl);
    const target = {
      kind: "opr",
      playerUrl,
      pageUrl,
      title: meta?.title,
      poster: meta?.poster,
      year: meta?.year,
      isSeries: !!(meta?.isSeries || serialHint),
      kpId: validHistoryKpId(meta?.kpId),
    };
    state.currentTarget = target;
    setWatchHead(target.title || "Opravar", target);
    if (meta && (meta.title || meta.poster || meta.description)) {
      renderMeta(meta, target);
    } else {
      el.metaPanel.classList.add("hidden");
    }
    recordOpen(target);
    if (!meta || !meta.title || !meta.description || !meta.rating) {
      healWatchMeta(target, token, meta, "oprmeta", playerUrl, "Opravar");
    }

    try {
      const resolved = await resolveOpravar(playerUrl, pageUrl);
      if (isStale(token)) return;
      const context = {
        playerUrl,
        pageUrl,
        base: resolved.base || "",
        playlist: resolved.playlist || [],
        selection: chooseOpravarSelection(
          resolved.playlist || [],
          (ndMeta ? serialHint : null) ||
            savedOpravarSelection(keyFor(target)) ||
            serialHint ||
            resolved.current,
        ),
      };
      const currentMatches = sameOpravarSelection(context.selection, resolved.current);
      const media = currentMatches
        ? resolved
        : await resolveOpravarVideo(playerUrl, context.selection.videoId, context.base);
      if (isStale(token)) return;
      await playOpravarMedia(media, context, target, token, currentMatches ? resumePosition(keyFor(target)) : 0);
    } catch (error) {
      if (isStale(token)) return;
      if (meta?.title) {
        log("opravar-fallback", { message: error.message, title: meta.title });
        return playZonaFallback(meta.title, meta.year, token, {
          meta,
          serialSelection: serialHint,
          forceSeries: target.isSeries,
        });
      }
      throw new Error("Плеер недоступен, а для резервного поиска не найдено название");
    }
  }

  async function playOpravarMedia(media, context, target, token, resume = 0, opts = {}) {
    if (!media?.source) throw new Error("Opravar не вернул HLS с открытым CORS");
    const selection = chooseOpravarSelection(context.playlist, context.selection);
    if (!selection?.videoId) throw new Error("Opravar не вернул выбранную серию/озвучку");
    context.selection = selection;
    persistOpravarSelection(target, selection, resume);
    await playShaka(media.source, "hls", token, {
      resume,
      historyKey: keyFor(target),
      audioPreference: opts.audioPreference,
      subtitlePreference: opts.subtitlePreference,
      opravar: context,
      textTracks: media.subtitles || [],
    });
    if (isStale(token)) return;
    startTracking(keyFor(target), target);
  }

  async function switchOpravarSelection(nextSelection) {
    const context = state.opravar;
    const target = state.currentTarget;
    if (!context || !target || target.kind !== "opr") return;
    const selection = chooseOpravarSelection(context.playlist, nextSelection);
    if (!selection?.videoId || sameOpravarSelection(selection, context.selection)) return;
    const token = resolveToken;
    const audioPreference = currentAudioPreference() || savedAudioPreference(keyFor(target));
    const subtitlePreference = currentSubtitlePreference() || savedSubtitlePreference(keyFor(target));
    await teardownPlayer();
    showPlayerLoading();
    try {
      const media = await resolveOpravarVideo(context.playerUrl, selection.videoId, context.base);
      if (isStale(token) || keyFor(state.currentTarget) !== keyFor(target)) return;
      await playOpravarMedia(media, { ...context, selection }, target, token, 0, {
        audioPreference,
        subtitlePreference,
      });
    } catch (error) {
      if (isStale(token)) return;
      if (target.title) {
        log("opravar-switch-fallback", { message: error.message, title: target.title });
        return playZonaFallback(target.title, target.year, token, {
          meta: state.currentMeta || target,
          audioPreference,
          subtitlePreference,
          serialSelection: {
            season: selection.season,
            episode: selection.episode,
          },
          forceSeries: true,
        });
      }
      showError(new Error("Не удалось переключить серию"));
    }
  }

  function persistOpravarSelection(target, selection, position = 0) {
    recordHistory({
      key: keyFor(target),
      kind: target.kind,
      target: cleanTarget(target),
      title: target.title || "",
      poster: target.poster || "",
      year: target.year || "",
      opravarSelection: {
        season: selection.season,
        episode: selection.episode,
        voiceId: selection.voiceId,
        videoId: selection.videoId,
        voiceName: selection.voiceName || "",
      },
      position,
      duration: 0,
      progress: 0,
    });
  }

  async function switchZenithSelection(nextSelection) {
    const context = state.serial;
    const target = state.currentTarget;
    if (!context || context.provider !== "zenith" || !target || context.switching) return;
    const selection = chooseSerialSelection(context.seasons, nextSelection);
    if (!selection || sameSerialSelection(selection, context.selection)) return;
    const episode = findSerialEpisode(context.seasons, selection);
    const media = bestZenithSource(episode?.sources);
    if (!media) return;

    const token = resolveToken;
    const audioPreference = currentAudioPreference() || savedAudioPreference(context.histKey || keyFor(target));
    const subtitlePreference = currentSubtitlePreference() || savedSubtitlePreference(context.histKey || keyFor(target));
    context.switching = true;
    renderTracks();
    await teardownPlayer();
    showPlayerLoading();
    persistSerialSelection(target, selection, true);

    try {
      if (isStale(token) || keyFor(state.currentTarget) !== keyFor(target)) return;
      const nextContext = { ...context, selection, switching: false };
      state.sources = episode.sources;
      state.audioNames = episode.audioNames?.length ? episode.audioNames : state.audioNames;
      await playShaka(media.url, media.kind, token, {
        resume: 0,
        historyKey: context.histKey || keyFor(target),
        audioPreference,
        subtitlePreference,
        textTracks: episode?.textTracks || [],
        serial: nextContext,
      });
      if (isStale(token)) return;
      startTracking(context.histKey || keyFor(target), target);
    } catch (error) {
      if (isStale(token)) return;
      log("zenith-episode-refresh", { selection, message: error.message });
      try {
        await playZenithEmbed(context.embedUrl, target, token, {
          histKey: context.histKey || keyFor(target),
          resume: 0,
          audioPreference,
          subtitlePreference,
          serialSelection: selection,
          forceWorker: true,
        });
      } catch (refreshError) {
        if (isStale(token)) return;
        showError(new Error("Не удалось загрузить выбранную серию"));
        log("zenith-episode-switch-error", { selection, message: refreshError.message });
      }
    }
  }

  async function playLiftw(id, token, opts = {}) {
    const safeId = positiveInt(id);
    if (!safeId) throw new Error("LiftW: неверный id");
    warmLiftwConnections();
    // Shaka downloads in parallel with the only two network stages there are.
    const shakaTask = ensureShaka();
    shakaTask.catch(() => {});

    const cachedMeta = cacheGet("curatedmeta", `lift:${safeId}`) || storedMeta(`lift:${safeId}`);
    const initialMeta = mergeMetadata(opts.meta || {}, cachedMeta || {});
    const initialTitle = movieTitle(initialMeta);
    const target = liftwTarget(safeId, opts.serialSelection || {});
    target.kpId = validHistoryKpId(initialMeta.kpId);
    target.title = isPlaceholderTitle(initialTitle) ? "" : initialTitle;
    target.poster = initialMeta.poster || "";
    target.year = initialMeta.year || "";
    target.isSeries = !!initialMeta.isSeries;
    state.currentTarget = target;
    if (target.title || target.poster) {
      setWatchHead(target.title, target);
      renderMeta(initialMeta, target);
    } else {
      el.watchTitle.textContent = "";
      document.title = SITE_TITLE;
      el.metaPanel.classList.add("hidden");
      updateBookmarkBtn(target);
    }

    const parsed = await resolveLiftwTitle(safeId, { force: !!opts.force });
    if (isStale(token)) return;

    let meta = mergeMetadata(parsed.meta, initialMeta);
    target.kpId = validHistoryKpId(meta.kpId, target.kpId);
    target.title = meta.title || target.title;
    target.poster = meta.poster || target.poster;
    target.year = meta.year || target.year;
    target.isSeries = !!meta.isSeries;
    setWatchHead(target.title, target);
    renderMeta(meta, target);
    recordOpen(target);
    cacheSet("curatedmeta", `lift:${safeId}`, meta, TTL.enriched);

    if (!metadataIsFull(meta)) {
      const enrich = async () => {
        if (!target.kpId && meta.year && !isPlaceholderTitle(movieTitle(meta))) {
          const rows = await searchPoiskkino(movieTitle(meta), meta.year);
          const names = new Set([movieTitle(meta), meta.originalTitle].filter(Boolean).map(suggestFold));
          const matches = rows.filter((row) => Number(row.year) === Number(meta.year) && !!row.isSeries === !!meta.isSeries
            && [row.name, row.title, row.alternativeName, row.originalTitle].some((name) => name && names.has(suggestFold(name))));
          if (matches.length === 1 && !isStale(token) && state.currentTarget === target) target.kpId = validHistoryKpId(matches[0].kpId);
        }
        return target.kpId ? fetchMovieMeta(target.kpId) : null;
      };
      enrich().then((fresh) => {
        if (!fresh || isStale(token) || state.currentTarget !== target) return;
        meta = mergeMetadata(meta, fresh);
        meta.kpId = target.kpId;
        target.title = movieTitle(meta) || target.title;
        target.poster = meta.poster || target.poster;
        target.year = meta.year || target.year;
        renderMeta(meta, target);
        cacheSet("curatedmeta", `lift:${safeId}`, meta, TTL.enriched);
        recordOpen(target);
      }).catch(() => {});
    }

    const seasons = parsed.playlist.seasons || [];
    const requested =
      normalizeSerialHint(opts.serialSelection) ||
      normalizeSerialHint(savedSerialSelection(keyFor(target))) ||
      parsed.playlist.current;
    const selection = seasons.length ? chooseSerialSelection(seasons, requested) : null;
    const episode = selection ? findSerialEpisode(seasons, selection) : null;
    const sources = episode?.sources || parsed.sources;
    const media = await pickLiftwLadder(sources);
    if (isStale(token)) return;
    if (!media) throw new Error("LiftW не отдал dash/hls для этого тайтла");

    if (selection) {
      target.season = selection.season;
      target.episode = selection.episode;
      target.isSeries = true;
      persistSerialSelection(target, selection);
      replaceHash(hashFor(target));
    }

    state.sources = sources;
    state.audioNames = (episode?.audioNames?.length ? episode.audioNames : parsed.audioNames) || [];
    state.blockedAudioNames = parsed.blockedAudioNames || [];
    const histKey = canonicalHistoryKey(target, meta);
    const serial = selection
      ? { provider: "liftw", liftId: String(safeId), histKey, seasons, selection, switching: false }
      : null;

    await shakaTask;
    if (isStale(token)) return;
    try {
      await playShaka(media.url, media.kind, token, {
        resume: opts.resume ?? resumePosition(histKey),
        historyKey: histKey,
        audioPreference: opts.audioPreference,
        audioLang: opts.audioLang,
        subtitlePreference: opts.subtitlePreference,
        textTracks: episode?.textTracks?.length ? episode.textTracks : parsed.textTracks,
        serial,
        opaqueMedia: "liftw",
      });
    } catch (error) {
      // The only thing a cached parse can get wrong is a signature that rotated
      // between the resolve and the click. Re-mint once, then let it stand.
      if (opts.force || isStale(token)) throw error;
      log("liftw-source-refresh", { id: safeId, message: error.message });
      await playLiftw(safeId, token, { ...opts, force: true, meta });
      return;
    }
    if (isStale(token)) return;
    startTracking(histKey, target);
  }

  async function switchLiftwSelection(nextSelection) {
    const context = state.serial;
    const target = state.currentTarget;
    if (!context || context.provider !== "liftw" || !target || context.switching) return;
    const selection = chooseSerialSelection(context.seasons, nextSelection);
    if (!selection || sameSerialSelection(selection, context.selection)) return;
    const episode = findSerialEpisode(context.seasons, selection);
    if (!bestLiftwSource(episode?.sources)) return;

    const token = resolveToken;
    // Read off the live player before anything can await: the dub has to be
    // sampled while the old episode is still loaded.
    const audioPreference = currentAudioPreference() || savedAudioPreference(context.histKey || keyFor(target));
    const subtitlePreference = currentSubtitlePreference() || savedSubtitlePreference(context.histKey || keyFor(target));
    // Claimed before the first await so a double-click cannot start two switches.
    context.switching = true;
    renderTracks();
    // Each episode carries its own ladders, so the AV1 health check is per
    // episode too — a season can change encoder mid-run the same way it changes
    // studios. Warm, this is a cache read; cold it is one small manifest GET.
    const media = await pickLiftwLadder(episode.sources);
    if (!media || isStale(token)) {
      context.switching = false;
      renderTracks();
      return;
    }
    await teardownPlayer();
    showPlayerLoading();
    target.season = selection.season;
    target.episode = selection.episode;
    persistSerialSelection(target, selection, true);
    replaceHash(hashFor(target));

    try {
      // histKey may be canonicalized to kp:<id>, while the active provider target
      // remains lift:<id>. It identifies the history bucket, not the live player.
      // Comparing the two abandoned every episode switch after showing the spinner.
      if (isStale(token) || state.currentTarget !== target) return;
      state.sources = episode.sources;
      state.audioNames = episode.audioNames?.length ? episode.audioNames : state.audioNames;
      await playShaka(media.url, media.kind, token, {
        resume: 0,
        historyKey: context.histKey,
        audioPreference,
        subtitlePreference,
        textTracks: episode.textTracks || [],
        serial: { ...context, selection, switching: false },
        opaqueMedia: "liftw",
      });
      if (isStale(token)) return;
      startTracking(context.histKey, target);
    } catch (error) {
      if (isStale(token)) return;
      log("liftw-episode-refresh", { selection, message: error.message });
      try {
        await playLiftw(context.liftId, token, {
          serialSelection: selection,
          resume: 0,
          audioPreference,
          subtitlePreference,
          force: true,
        });
      } catch (refreshError) {
        if (isStale(token)) return;
        showError(new Error("Не удалось загрузить выбранную серию"));
        log("liftw-episode-switch-error", { selection, message: refreshError.message });
      }
    }
  }

  function persistSerialSelection(target, selection, resetPlayback = false) {
    const entry = {
      key: keyFor(target),
      kind: target.kind,
      target: cleanTarget(target),
      title: target.title || "",
      poster: target.poster || "",
      year: target.year || "",
      serialSelection: {
        season: selection.season,
        episode: selection.episode,
      },
    };
    if (resetPlayback) {
      entry.position = 0;
      entry.duration = 0;
      entry.progress = 0;
    }
    recordHistory(entry);
  }

  // Smart-TV / projector browsers (Samsung Tizen, WebOS, generic SMART-TV, etc.)
  // composite an iframe-embedded <video> without the hardware overlay a top-level
  // player gets, so it micro-stutters whenever the shared main thread is busy.
  // We use this to shed the periodic work we inject into the Ortified srcdoc
  // (see progressHook) on exactly those devices.
  function samsungTizenVideoDevice() {
    const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
    return /\bTizen\b/i.test(ua) && /SMART-?TV|SamsungBrowser[^\n]*\bTV\b/i.test(ua);
  }

  function weakVideoDevice() {
    const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
    if (samsungTizenVideoDevice() || /SMART-?TV|SmartTV|\bWebOS\b|Web0S|\bNetCast\b|\bBRAVIA\b|CrKey|AFT[A-Z]|\bHbbTV\b|\bVIDAA\b/i.test(ua)) return true;
    const cores = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 0;
    return cores > 0 && cores <= 2;
  }

  async function playNd(pageUrl, token) {
    setWatchHead("Newdeaf…", { kind: "nd", pageUrl });
    const parsed = await resolveNewdeafPage(pageUrl);
    if (isStale(token)) return;
    const enriched = cacheGet(ND_ENRICHED_CACHE_NS, pageUrl);
    const serialHint = newdeafSerialHint(
      parsed.title || "",
      pageUrl,
      parsed.opravar[0] || "",
      parsed.allo[0] || "",
    );
    const ndMeta = mergeMetadata(
      { title: parsed.title, poster: parsed.poster, year: parsed.year, description: parsed.description },
      enriched,
    );
    if (serialHint) {
      ndMeta.isSeries = true;
      ndMeta.serialSelection = serialHint;
    }
    if (!ndMeta.rating?.kp && !ndMeta.rating?.imdb) {
      enrichNewdeafMetadata(ndMeta, pageUrl, token).catch(() => {});
    }

    if (parsed.ortified.length) {
      const embedUrl = parsed.ortified[0];
      // Persist the newdeaf meta keyed by the embed so a later reopen (which goes
      // straight to /watch/ort/<embedUrl>, never touching newdeaf again) can still
      // show poster/description/title in the sidebar.
      cacheSet("ortmeta", embedUrl, ndMeta, TTL.meta);
      // Upgrade the URL to the resolved Ortified target so this title never
      // touches newdeaf again (re-open / share / history all go direct).
      replaceHash(`/watch/ort/${encodeURIComponent(embedUrl)}`);
      return playOrt(embedUrl, token, ndMeta);
    }

    if (parsed.opravar.length) {
      const playerUrl = parsed.opravar[0];
      const oprMeta = { ...ndMeta, pageUrl };
      cacheSet("oprmeta", playerUrl, oprMeta, TTL.meta);
      replaceHash(`/watch/opr/${encodeURIComponent(playerUrl)}`);
      return playOpr(playerUrl, token, oprMeta);
    }

    // Allo-only or no player → Zona fallback via title -> kpId, then upgrade URL.
    return playZonaFallback(parsed.title, parsed.year, token, {
      meta: ndMeta,
      serialSelection: serialHint,
      forceSeries: !!(ndMeta.isSeries || serialHint),
    });
  }

  async function playZonaFallback(rawTitle, year, token, opts = {}) {
    const title = cleanMovieTitle(rawTitle || "");
    if (!title) throw new Error("Не найдено название для резервного поиска");
    let movie = opts.meta?.kpId ? opts.meta : null;
    if (!movie) {
      const results = await searchPoiskkino(title, year);
      if (isStale(token)) return;
      movie = chooseMovie(results, title, year);
    }
    if (!movie) {
      // No kpId means Collaps/Zona/Zenith can't even be tried — but HDRezka
      // resolves by title, so give the last resort a chance before failing.
      const target = state.currentTarget || { kind: "kp", title, year };
      const played = await tryRezkaLastResort(target, opts.meta || null, token, {
        title, year,
        histKey: keyFor(target),
        resume: resumePosition(keyFor(target)),
        serialSelection: opts.serialSelection,
      });
      if (played || isStale(token)) return;
      throw new Error("PoiskKino не вернул kpId для Zona fallback");
    }
    const meta = mergeMetadata(opts.meta || {}, movie);
    cacheMovieMetadata(movie.kpId, meta);
    replaceHash(`/watch/kp/${encodeURIComponent(movie.kpId)}`);
    return playKp(String(movie.kpId), token, {
      meta,
      audioPreference: opts.audioPreference,
      subtitlePreference: opts.subtitlePreference,
      serialSelection: opts.serialSelection,
      forceSeries: !!(opts.forceSeries || meta.isSeries || opts.serialSelection),
    });
  }

  // =====================================================================
  // Playback — HDRezka (the LAST-RESORT source)
  //
  // Reached either from an explicit 720p search card or after Collaps AND
  // Zona/Zenith fail. The resolver
  // relays short-lived signed Voidboost MP4/VTT URLs (a few KB); the video bytes
  // stream browser -> Voidboost directly, so this never loads the resolver with
  // video. Search may probe one top movie only after its Collaps probe misses;
  // everything else resolves on a real click. A localStorage kill switch
  // (alphy.rezka.off) lets it be disabled without a redeploy.
  // =====================================================================
  const rezkaResolveCache = new Map();
  const REZKA_RESOLVE_TTL_MS = 8 * 60e3;

  function rezkaLastResortEnabled() {
    try { return localStorage.getItem("alphy.rezka.off") !== "1"; } catch { return true; }
  }

  function rezkaTranslatorName(t) {
    const base = t?.name || `Озвучка ${t?.id}`;
    const tags = [t?.director ? "реж." : "", t?.camrip ? "camrip" : ""].filter(Boolean).join(", ");
    return tags ? `${base} (${tags})` : base;
  }

  function savedRezkaPref(key, field) {
    return historyEntryFor(key)?.[field] || null;
  }
  function persistRezkaPref(key, patch) {
    const t = state.currentTarget;
    if (!t || !key) return;
    recordHistory({
      key, kind: t.kind, target: cleanTarget(t),
      title: t.title || "", poster: t.poster || "", year: t.year || "", ...patch,
    });
  }

  function openRezkaHit(hit, details = {}) {
    const target = rezkaTarget(hit.rezkaId, hit.kpId);
    const meta = {
      ...details,
      title: details.title || hit.title || `Фильм ${hit.rezkaId}`,
      year: details.year || hit.year || "",
      poster: details.poster || hit.poster || "",
      rating: details.rating || hit.rating || {},
      movieLength: details.movieLength || hit.movieLength || null,
      isSeries: false,
      kpId: String(hit.kpId || ""),
    };
    cacheSet("curatedmeta", keyFor(target), meta, TTL.enriched);
    if (target.kpId) cacheMovieMetadata(target.kpId, meta);
    go(hashFor(target));
  }

  async function resolveRezka(
    { kpId = null, title = null, year = null, rezkaId = null, translator = null } = {},
    { force = false } = {},
  ) {
    const params = new URLSearchParams();
    if (rezkaId) params.set("id", String(rezkaId));
    else if (title) { params.set("title", title); if (year) params.set("year", String(year)); }
    else if (kpId) params.set("kp", String(kpId));
    else throw new Error("HDRezka: не задан фильм");
    if (translator) params.set("translator", String(translator));
    const path = `/resolve-rezka?${params}`;
    if (force) rezkaResolveCache.delete(path);
    const cached = rezkaResolveCache.get(path);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const data = await resolverJson(path, { retries: 0, timeoutMs: 20000 });
    if (!data.ok || !data.best?.url) throw new Error(data.message || "HDRezka не вернул поток");
    const entry = { value: data, expiresAt: Date.now() + REZKA_RESOLVE_TTL_MS };
    rezkaResolveCache.set(path, entry);
    // A search preview resolves by title, while its permanent card opens by the
    // stable Rezka ID. Alias the same fresh signed payload so that click is instant.
    if (!translator && data.movie?.rezkaId) {
      rezkaResolveCache.set(`/resolve-rezka?id=${encodeURIComponent(data.movie.rezkaId)}`, entry);
    }
    return data;
  }

  function chooseRezkaStream(streams, wantLabel) {
    const sorted = [...streams].sort((a, b) => (b.quality || 0) - (a.quality || 0));
    if (wantLabel) {
      const match = sorted.find((s) => s.label === wantLabel);
      if (match) return match;
    }
    return sorted[0];
  }

  async function playRezkaRoute(rezkaId, kpId, token) {
    const target = rezkaTarget(rezkaId, kpId);
    const histKey = keyFor(target);
    let meta = cacheGet("curatedmeta", histKey) || storedMeta(histKey) ||
      (target.kpId ? cacheGet("meta", target.kpId) || cacheGet("metasummary", target.kpId) : null);
    const metaTask = target.kpId && !metadataIsFull(meta)
      ? fetchMovieMeta(target.kpId).catch(() => null)
      : Promise.resolve(meta);
    const savedDub = savedRezkaPref(histKey, "rezkaTranslator");
    const resolveTask = savedDub
      ? resolveRezka({ rezkaId, translator: savedDub }).catch(() => resolveRezka({ rezkaId }))
      : resolveRezka({ rezkaId });

    target.title = movieTitle(meta) || meta?.title || `Фильм ${rezkaId}`;
    target.poster = meta?.poster || "";
    target.year = meta?.year || "";
    target.isSeries = false;
    state.currentTarget = target;
    setWatchHead(target.title, target);
    if (meta) renderMeta(meta, target);
    recordOpen(target);

    const [resolved, freshMeta] = await Promise.all([resolveTask, metaTask]);
    if (isStale(token)) return;
    if (freshMeta && freshMeta !== meta) {
      meta = { ...freshMeta, kpId: target.kpId || freshMeta.kpId };
      cacheSet("curatedmeta", histKey, meta, TTL.enriched);
      if (target.kpId) cacheMovieMetadata(target.kpId, meta);
      target.title = movieTitle(meta) || meta.title || target.title;
      target.poster = meta.poster || target.poster;
      target.year = meta.year || target.year;
      setWatchHead(target.title, target);
      renderMeta(meta, target);
      recordOpen(target);
    }
    await playRezka(resolved, target, token, {
      histKey,
      resume: resumePosition(histKey),
    });
  }

  async function playRezka(resolved, target, token, opts = {}) {
    if (isStale(token)) return;
    await teardownPlayer();
    resetSubtitleRequest();
    const histKey = opts.histKey || keyFor(target);
    const streams = (resolved.streams || []).filter((s) => s.url);
    if (!streams.length) throw new Error("HDRezka не вернул качество");
    const pick = chooseRezkaStream(streams, opts.qualityKey || savedRezkaPref(histKey, "rezkaQuality"));
    warmRezkaConnections(resolved);

    state.rezka = {
      streams: [...streams].sort((a, b) => (b.quality || 0) - (a.quality || 0)),
      subtitles: resolved.subtitles || [],
      translators: (resolved.translators || []).length
        ? resolved.translators
        : (resolved.translatorCandidates || []),
      translatorId: resolved.translatorId,
      movie: resolved.movie || {},
      target,
      histKey,
      qualityLabel: pick.label,
      retryCount: Number(opts.retryCount || 0),
      refreshing: false,
      switchingTranslator: false,
    };

    const video = document.createElement("video");
    video.controls = true;
    video.playsInline = true;
    mountPaused(video);
    video.playbackRate = state.playbackRate;
    // Deliberately NO crossOrigin: the Voidboost MP4 host sends no CORS headers,
    // and native <video> playback of a cross-origin source does not need them.
    // Subtitles are attached as same-origin blob <track>s instead (see below), so
    // we never force the media element into a CORS check the CDN would fail.
    if (isStale(token)) return;
    el.playerHost.replaceChildren(video);
    state.videoEl = video;

    const resume = opts.resume || 0;
    video.addEventListener("loadedmetadata", () => {
      if (resume > 5) { try { video.currentTime = resume; } catch { /* ignore */ } }
    }, { once: true });

    let ready = false;
    const onReady = () => {
      if (ready || isStale(token) || state.videoEl !== video) return;
      ready = true;
      video.playbackRate = state.playbackRate;
      renderRezkaControls();
      markPlayerReady();
      startTracking(histKey, target);
      startPlaybackIfAllowed(video, { resume: resume > 5 });
    };
    video.addEventListener("canplay", onReady, { once: true });
    video.addEventListener("error", () => {
      if (isStale(token) || state.videoEl !== video) return;
      log("rezka-video-error", { code: video.error?.code, histKey });
      const r = state.rezka;
      if (!r || r.refreshing || r.retryCount >= 1 || !r.movie?.rezkaId) {
        showError(new Error("Резервный поток не открылся или перестал отвечать."));
        return;
      }
      r.refreshing = true;
      renderRezkaControls();
      const at = video.currentTime || opts.resume || 0;
      resolveRezka({ rezkaId: r.movie.rezkaId, translator: r.translatorId }, { force: true })
        .then((fresh) => {
          if (isStale(token) || state.rezka !== r) return;
          return playRezka(fresh, r.target, token, {
            histKey: r.histKey,
            resume: at,
            qualityKey: r.qualityLabel,
            retryCount: r.retryCount + 1,
          });
        })
        .catch((error) => {
          if (!isStale(token) && state.rezka === r) {
            r.refreshing = false;
            renderRezkaControls();
            showError(new Error(`Резервный поток не восстановился: ${error.message}`));
          }
        });
    });
    // Start loading the MP4 immediately — do not block first bytes on the subtitle
    // fetch below.
    video.src = pick.url;
    video.load();

    // Subtitles come straight from the resolve. Fetch each VTT client-side (the
    // Voidboost subtitle host sends Access-Control-Allow-Origin: *) and attach it
    // as a same-origin blob <track> so it works without crossOrigin on the video.
    // Runs alongside playback; controls re-render once tracks land.
    attachRezkaSubtitles(video, state.rezka.subtitles, token).then(() => {
      if (!isStale(token) && state.videoEl === video && ready) renderRezkaControls();
    });

    // If canplay is slow (cold CDN), still reveal controls so the user isn't stuck
    // on a spinner over an already-loading <video>.
    setTimeout(() => {
      if (!ready && !isStale(token) && state.videoEl === video) renderRezkaControls();
    }, 2600);
  }

  async function attachRezkaSubtitles(video, subs, token) {
    const loaded = await Promise.all((subs || []).map(async (sub) => {
      try {
        // Through the sandbox, not directly. A plain cross-origin fetch sends
        // `Origin: https://alphy.tv` no matter what the referrer policy says —
        // Origin is not covered by it — so turning subtitles on announced this
        // site to Voidboost on every use. The opaque origin makes it
        // `Origin: null` instead; the host answers `ACAO: *`, so nothing else
        // about the request changes. No direct fallback, for the same reason as
        // Collaps: a privacy boundary that degrades into leaking is not one.
        const raw = (await sandboxFetchText(sub.url, "rezka-subs", 12000))
          .replace(/^﻿/, "");
        if (!raw.trim()) return null;
        const vtt = /^WEBVTT/i.test(raw.trim()) ? raw : subtitleTextToVtt(raw, "srt");
        return { sub, vtt };
      } catch (error) {
        log("rezka-subtitle-warn", { url: sub.url, message: error.message });
        return null;
      }
    }));
    if (isStale(token) || state.videoEl !== video) return;
    for (const item of loaded.filter(Boolean)) {
      const blobUrl = URL.createObjectURL(new Blob([item.vtt], { type: "text/vtt;charset=utf-8" }));
      state.subtitleObjectUrls.push(blobUrl);
      const track = document.createElement("track");
      track.kind = "subtitles";
      track.label = item.sub.label || item.sub.lang || "Субтитры";
      track.srclang = item.sub.lang || "und";
      track.src = blobUrl;
      video.appendChild(track);
    }
  }

  function renderRezkaControls() {
    const r = state.rezka;
    const video = state.videoEl;
    if (!r || !video) return;
    el.serialPanel.replaceChildren();
    el.serialPanel.classList.add("hidden");
    el.trackPanel.replaceChildren();
    el.trackPanel.classList.remove("hidden");

    // Audio tracks are authoritative when the film page is reachable. Datacenter
    // WAF blocks it often, so tentative common IDs are resolved only when clicked.
    if (r.translators.length > 1) {
      addTrackGroup("Озвучка", r.translators, (t) => {
        const btn = document.createElement("button");
        btn.textContent = rezkaTranslatorName(t);
        if (Number(t.id) === Number(r.translatorId)) btn.className = "active";
        btn.disabled = !!(r.switchingTranslator || r.refreshing);
        btn.addEventListener("click", () => { switchRezkaTranslator(t.id).catch((e) => showError(e)); });
        return btn;
      });
    }

    // Quality — the label is HDRezka's; the active button also shows the real
    // decoded resolution so a "720p" that is physically 480p is never disguised.
    addTrackGroup("Качество", r.streams, (s) => {
      const btn = document.createElement("button");
      const real = (s.label === r.qualityLabel && video.videoWidth)
        ? ` · ${video.videoWidth}×${video.videoHeight}` : "";
      btn.textContent = `${s.label}${real}`;
      if (s.label === r.qualityLabel) btn.className = "active";
      btn.disabled = !!(r.switchingTranslator || r.refreshing);
      btn.addEventListener("click", () => switchRezkaQuality(s.label));
      return btn;
    });

    // Subtitles — native text tracks (from the blob <track>s), off by default.
    const tracks = [...video.textTracks];
    if (tracks.length) {
      const anyShowing = tracks.some((t) => t.mode === "showing");
      addTrackGroup("Субтитры", [{ off: true }, ...tracks], (item) => {
        const btn = document.createElement("button");
        if (item.off) {
          btn.textContent = "Выкл";
          if (!anyShowing) btn.className = "active";
          btn.addEventListener("click", () => {
            for (const t of video.textTracks) t.mode = "disabled";
            setTimeout(renderRezkaControls, 40);
          });
        } else {
          btn.textContent = item.label || item.language || "Субтитры";
          if (item.mode === "showing") btn.className = "active";
          btn.addEventListener("click", () => {
            for (const t of video.textTracks) t.mode = (t === item ? "showing" : "disabled");
            setTimeout(renderRezkaControls, 40);
          });
        }
        return btn;
      });
    }

    const note = document.createElement("div");
    note.className = "track-note muted";
    note.textContent = r.refreshing
      ? "Обновляем ссылку на резервный поток…"
      : "Резервный источник без рекламы. Фактическое разрешение показано на активной кнопке.";
    el.trackPanel.appendChild(note);
  }

  function switchRezkaQuality(label) {
    const r = state.rezka;
    const video = state.videoEl;
    if (!r || !video || label === r.qualityLabel) return;
    const stream = r.streams.find((s) => s.label === label);
    if (!stream?.url) return;
    const at = video.currentTime || 0;
    const wasPlaying = !video.paused;
    r.qualityLabel = label;
    persistRezkaPref(r.histKey, { rezkaQuality: label });
    video.addEventListener("loadedmetadata", () => {
      try { video.currentTime = at; } catch { /* ignore */ }
      if (wasPlaying) video.play().catch(() => { /* ignore */ });
    }, { once: true });
    video.src = stream.url;
    video.load();
    renderRezkaControls();
  }

  async function switchRezkaTranslator(translatorId) {
    const r = state.rezka;
    if (!r || r.switchingTranslator || Number(translatorId) === Number(r.translatorId)) return;
    if (!r.movie?.rezkaId) return;
    const token = resolveToken;
    const at = state.videoEl?.currentTime || 0;
    r.switchingTranslator = true;
    renderRezkaControls();
    try {
      const resolved = await resolveRezka({ rezkaId: r.movie.rezkaId, translator: translatorId });
      if (isStale(token) || state.rezka !== r) return;
      persistRezkaPref(r.histKey, { rezkaTranslator: String(translatorId) });
      await playRezka(resolved, r.target, token, {
        histKey: r.histKey,
        resume: at,
        qualityKey: r.qualityLabel,
      });
    } catch (error) {
      if (!isStale(token) && state.rezka === r) {
        r.switchingTranslator = false;
        r.translators = r.translators.filter((item) => Number(item.id) !== Number(translatorId));
        renderRezkaControls();
      }
      throw new Error(`Эта озвучка недоступна: ${error.message}`);
    }
  }

  // The last-resort entry point: resolve HDRezka for a title and play it. Returns
  // true if playback started, false if HDRezka could not deliver (so the caller
  // surfaces the ORIGINAL, more familiar error instead of a Rezka-specific one).
  // Tried before HDRezka: LiftW carries series as well as films, plays natively
  // through Shaka off its own CDN, and costs the resolver nothing. It is a
  // fallback rather than a preferred rung because reaching it from a Kinopoisk id
  // needs a search plus a confirmation, which the warm kp path does not.
  async function tryLiftwLastResort(target, meta, token, opts = {}) {
    const kpId = String(positiveInt(opts.kpId || target?.kpId || meta?.kpId) || "");
    if (!kpId) return false;
    try {
      const liftId = await findLiftwByKpId(kpId, {
        title: movieTitle(meta) || target?.title || "",
        originalTitle: meta?.alternativeName || meta?.enName || "",
        year: meta?.year || target?.year || null,
        isSeries: !!(meta?.isSeries ?? target?.isSeries),
      });
      if (isStale(token)) return true;
      if (!liftId) return false;
      log("liftw-last-resort", { kpId, liftId });
      await playLiftw(liftId, token, {
        meta,
        serialSelection: opts.serialSelection,
        resume: opts.resume || 0,
      });
      if (!isStale(token)) replaceHash(hashFor(state.currentTarget));
      return true;
    } catch (error) {
      if (isStale(token)) return true;
      log("liftw-last-resort-fail", { kpId, message: error.message });
      return false;
    }
  }

  async function tryRezkaLastResort(target, meta, token, opts = {}) {
    if (!rezkaLastResortEnabled()) return false;
    const title = cleanMovieTitle(opts.title || movieTitle(meta) || target?.title || "");
    const year = opts.year || meta?.year || target?.year || null;
    // A bare kpId is no longer enough. The resolver used to turn one into a title
    // by asking Collaps, which meant OUR server hit a source directly on every
    // Rezka resolve — one datacenter IP, one fixed UA, perfectly correlatable —
    // while the whole browser-side design exists to keep that from happening.
    // Rezka only searches by title anyway, and by the time this runs every caller
    // that can succeed already has one; without a title there is nothing to search.
    if (!title) return false;
    // A series episode picker is out of scope for the fallback — HDRezka series
    // need per-episode get_stream calls the resolver does not yet make.
    if (target?.isSeries || meta?.isSeries || opts.serialSelection) return false;
    try {
      const savedDub = opts.histKey ? savedRezkaPref(opts.histKey, "rezkaTranslator") : null;
      const request = { title, year: year || null, translator: savedDub };
      const resolved = savedDub
        ? await resolveRezka(request).catch(() => resolveRezka({ ...request, translator: null }))
        : await resolveRezka(request);
      if (isStale(token)) return true;
      log("rezka-last-resort", { title: resolved.movie?.title, best: resolved.best?.label });
      await playRezka(resolved, target, token, {
        histKey: opts.histKey || keyFor(target),
        resume: opts.resume || 0,
      });
      return true;
    } catch (error) {
      if (isStale(token)) return true;
      log("rezka-last-resort-fail", { message: error.message });
      return false;
    }
  }

  // Descriptive list fields (жанры, страны, режиссёры, актёры). An empty array is
  // truthy, so a plain {...right, ...left} spread would let an empty left-hand
  // list mask a populated right-hand one — the exact case where a partial cached
  // entry would wipe out freshly fetched credits.
  const META_LIST_FIELDS = ["genres", "countries", "directors", "cast"];

  function pickList(left, right, field) {
    const a = Array.isArray(left?.[field]) ? left[field] : [];
    const b = Array.isArray(right?.[field]) ? right[field] : [];
    return a.length ? a : b;
  }

  function personRefList(value, limit = 12) {
    if (!Array.isArray(value)) return [];
    const out = [];
    const seen = new Set();
    for (const person of value) {
      const id = String(person?.id || person?.staffId || "");
      const name = String(person?.name || person?.nameRu || person?.nameEn || "").trim();
      if (!/^\d+$/.test(id) || !name || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, name });
      if (out.length >= limit) break;
    }
    return out;
  }

  function pickPeople(left, right, field, limit) {
    const a = personRefList(left?.people?.[field], limit);
    const b = personRefList(right?.people?.[field], limit);
    return a.length ? a : b;
  }

  function mergeMetadata(base, enriched) {
    const left = base && typeof base === "object" ? base : {};
    const right = enriched && typeof enriched === "object" ? enriched : {};
    const merged = {
      ...right,
      ...left,
      title: left.title || movieTitle(left) || right.title || movieTitle(right) || "",
      year: left.year || right.year || "",
      poster: left.poster || right.poster || "",
      backdrop: left.backdrop || right.backdrop || "",
      description: left.description || left.shortDescription || right.description || right.shortDescription || "",
      shortDescription: left.shortDescription || right.shortDescription || "",
      originalTitle: left.originalTitle || left.alternativeName || left.enName ||
        right.originalTitle || right.alternativeName || right.enName || "",
      isSeries: left.isSeries ?? right.isSeries ?? false,
      // A Kinopoisk id is an identity, never a value to clear. Leaving it to the
      // plain spread let the empty kpId of a first, placeholder render mask the
      // real one that arrived with the source payload a moment later — which is
      // exactly how LiftW pages ended up with no credits and no «Похожее».
      kpId: left.kpId || right.kpId || "",
      movieLength: left.movieLength || right.movieLength || null,
      ageRating: left.ageRating ?? right.ageRating ?? null,
      ratingMpaa: left.ratingMpaa || right.ratingMpaa || null,
      rating: {
        ...(right.rating || {}),
        ...(left.rating || {}),
      },
      externalId: {
        imdb: left.externalId?.imdb || left.externalIds?.imdb || left.imdbId ||
          right.externalId?.imdb || right.externalIds?.imdb || right.imdbId || "",
        tmdb: left.externalId?.tmdb || left.externalIds?.tmdb || left.tmdbId ||
          right.externalId?.tmdb || right.externalIds?.tmdb || right.tmdbId || "",
      },
      metaLevel: left.metaLevel === "full" || right.metaLevel === "full"
        ? "full"
        : (left.metaLevel || right.metaLevel || ""),
      people: {
        directors: pickPeople(left, right, "directors", 3),
        cast: pickPeople(left, right, "cast", 8),
      },
    };
    for (const field of META_LIST_FIELDS) merged[field] = pickList(left, right, field);
    return merged;
  }

  async function enrichNewdeafMetadata(meta, pageUrl, token) {
    const cleanTitle = [...matchTitleTokens(meta?.title || "")].join(" ");
    if (!cleanTitle) return null;
    const results = await searchPoiskkino(cleanTitle, meta?.year);
    const match = matchNewdeafMetadata({ title: meta?.title, url: pageUrl }, results);
    if (!match) return null;
    cacheSet(ND_ENRICHED_CACHE_NS, pageUrl, match, TTL.enriched);
    if (isStale(token) || !state.currentTarget) return match;
    const merged = mergeMetadata(meta, match);
    state.currentMeta = merged;
    state.currentTarget.poster = merged.poster || state.currentTarget.poster;
    state.currentTarget.year = merged.year || state.currentTarget.year;
    state.currentTarget.isSeries = merged.isSeries;
    renderMeta(merged, state.currentTarget);
    if (state.currentTarget.kind === "ort") cacheSet("ortmeta", state.currentTarget.embedUrl, merged, TTL.enriched);
    if (state.currentTarget.kind === "opr") {
      cacheSet("oprmeta", state.currentTarget.playerUrl, {
        ...merged,
        pageUrl: state.currentTarget.pageUrl || pageUrl,
      }, TTL.enriched);
    }
    window.dispatchEvent(new CustomEvent("alphy:metadata", { detail: merged }));
    return match;
  }

  function setWatchHead(title, target) {
    el.watchTitle.textContent = title;
    document.title = `${title} — ${SITE_TITLE}`;
    updateBookmarkBtn(target);
  }

  // MPAA is stored as a bare code ("r", "pg13"); Kinopoisk's own age limit is the
  // number Russian viewers actually recognise, so it leads and MPAA follows.
  function ageBadge(meta) {
    const rawAge = meta?.ageRating;
    if (rawAge !== null && rawAge !== undefined && rawAge !== "") {
      const age = Number(rawAge);
      if (Number.isFinite(age) && age >= 0) return `${age}+`;
    }
    const mpaa = String(meta?.ratingMpaa || "").trim();
    return mpaa ? mpaa.toUpperCase().replace(/^NC17$/, "NC-17").replace(/^PG13$/, "PG-13") : "";
  }

  function metaFactRow(label, value) {
    if (!value) return "";
    return `<div class="mf-row"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
  }

  function kinopoiskFilmUrl(kpId) {
    return /^\d+$/.test(String(kpId || ""))
      ? `https://www.kinopoisk.ru/film/${encodeURIComponent(kpId)}/`
      : "";
  }

  function imdbTitleUrl(imdbId) {
    const id = String(imdbId || "");
    return /^tt\d{6,10}$/.test(id) ? `https://www.imdb.com/title/${encodeURIComponent(id)}/` : "";
  }

  function kinopoiskPersonUrl(personId) {
    return /^\d+$/.test(String(personId || ""))
      ? `https://www.kinopoisk.ru/name/${encodeURIComponent(personId)}/`
      : "";
  }

  function metaPeopleRow(label, names, refs) {
    const visible = (Array.isArray(names) ? names : []).filter(Boolean);
    if (!visible.length) return "";
    const byName = new Map(personRefList(refs).map((person) => [person.name.toLocaleLowerCase("ru-RU"), person]));
    const html = visible.map((name) => {
      const person = byName.get(String(name).toLocaleLowerCase("ru-RU"));
      const href = kinopoiskPersonUrl(person?.id);
      return href
        ? `<a class="kp-meta-link" href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(name)}</a>`
        : escapeHtml(name);
    }).join(", ");
    return `<div class="mf-row"><dt>${escapeHtml(label)}</dt><dd>${html}</dd></div>`;
  }

  let lastMetaRenderSignature = "";

  function renderMeta(meta, target) {
    if (!meta) {
      el.metaPanel.classList.add("hidden");
      el.metaPanel.replaceChildren();
      return;
    }
    const title = movieTitle(meta) || target.title || "";
    const year = meta.year || target.year || "";
    const poster = meta.poster || target.poster || "";
    const desc = meta.description || meta.shortDescription || "";
    const targetKpId = (target?.kind === "kp" || target?.kind === "clps") ? target.kpId : "";
    const mergedMeta = mergeMetadata(state.currentMeta || {}, {
      ...meta,
      kpId: meta.kpId || targetKpId || state.currentMeta?.kpId || "",
      title,
      year,
      poster,
      description: desc,
      isSeries: meta.isSeries ?? target?.isSeries,
    });
    // Source payloads often begin as film-shaped placeholders and learn their
    // real type a moment later. Once any payload for this title proves it is a
    // series, a stale `false` must not mask that correction.
    mergedMeta.isSeries = state.currentMeta?.isSeries === true ||
      meta.isSeries === true || target?.isSeries === true;
    state.currentMeta = mergedMeta;
    // Render from the MERGED view, not the incoming fragment: a later partial
    // update (say a bare title from the resolver) must not blank out credits that
    // an earlier, richer payload already delivered.
    const view = state.currentMeta;
    if (view?.kpId && target) attachHistoryKpId(keyFor(target), view.kpId);

    const kp = view.rating?.kp;
    const imdb = view.rating?.imdb;
    const isSeries = view.isSeries ?? target?.isSeries ?? false;
    const age = ageBadge(view);
    const sub = [
      year,
      isSeries ? "сериал" : "фильм",
      view.movieLength ? formatDuration(view.movieLength, isSeries) : "",
    ].filter(Boolean).join(" · ");
    const signature = JSON.stringify({
      target: keyFor(target), title, year, poster, desc, sub, age,
      rating: view.rating || {}, genres: view.genres || [], countries: view.countries || [],
      directors: view.directors || [], cast: view.cast || [], people: view.people || {},
      externalId: view.externalId || {},
    });
    if (signature === lastMetaRenderSignature) {
      scheduleWatchExtras(target);
      return;
    }
    lastMetaRenderSignature = signature;

    const preservedPoster = el.metaPanel.querySelector(".meta-poster img");
    const preservedLetterboxd = el.metaPanel.querySelector(".rt-lb");
    const canPreserveLetterboxd = !isSeries &&
      preservedLetterboxd?.dataset.watchToken === String(resolveToken) &&
      preservedLetterboxd?.dataset.targetKey === keyFor(target);

    // Three children, and always three: poster, body, credits. Narrow layouts put
    // the first two side by side and let the credits span underneath, which is
    // what gives the poster room to be worth looking at on a phone.
    //
    // A fixed set of children is the point. Ratings, description and credits are
    // each individually optional, and a grid row-span over a variable number of
    // implicit rows does not survive that — it is how the two columns used to
    // overlap on phones. Each child owns exactly one cell instead.
    const kpUrl = kinopoiskFilmUrl(view.kpId);
    let body = `<div class="meta-headline">`;
    body += kpUrl
      ? `<a class="mp-title kp-meta-link" href="${escapeAttr(kpUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(title)}</a>`
      : `<div class="mp-title">${escapeHtml(title)}</div>`;
    // The age rating reads as part of the same sentence as the year and the kind,
    // so it is separated the same way they are rather than floated off on its own.
    body += `<div class="mp-sub">${escapeHtml(sub)}${age
      ? `<span class="mp-dot" aria-hidden="true">·</span><span class="mp-age">${escapeHtml(age)}</span>`
      : ""}</div>`;
    body += `</div>`;
    if (kp || imdb) {
      body += `<div class="meta-ratings">`;
      if (kp) body += kpUrl
        ? `<a class="rt kp-rating-link" href="${escapeAttr(kpUrl)}" target="_blank" rel="noopener noreferrer"><b>${escapeHtml(Number(kp).toFixed(1))}</b><span>Кинопоиск</span></a>`
        : `<div class="rt"><b>${escapeHtml(Number(kp).toFixed(1))}</b><span>Кинопоиск</span></div>`;
      if (imdb) {
        const imdbUrl = imdbTitleUrl(view.externalId?.imdb);
        body += imdbUrl
          ? `<a class="rt rt-imdb kp-rating-link" href="${escapeAttr(imdbUrl)}" target="_blank" rel="noopener noreferrer"><b>${escapeHtml(Number(imdb).toFixed(1))}</b><span>IMDb</span></a>`
          : `<div class="rt rt-imdb"><b>${escapeHtml(Number(imdb).toFixed(1))}</b><span>IMDb</span></div>`;
      }
      body += `</div>`;
    }
    if (desc) {
      body += `<div class="meta-desc">${escapeHtml(desc)}</div>`;
      body += `<button class="meta-desc-toggle hidden" type="button">ещё</button>`;
    }

    const facts =
      metaFactRow("Жанр", (view.genres || []).slice(0, 3).join(", ")) +
      metaFactRow("Страна", (view.countries || []).slice(0, 2).join(", ")) +
      metaPeopleRow(
        (view.directors || []).length > 1 ? "Режиссёры" : "Режиссёр",
        (view.directors || []).slice(0, 2),
        view.people?.directors,
      ) +
      metaPeopleRow("В ролях", (view.cast || []).slice(0, 5), view.people?.cast);
    const factsHtml = facts ? `<dl class="meta-facts">${facts}</dl>` : "";

    const posterHtml = poster
      ? `<div class="meta-poster"><img src="${escapeAttr(poster)}" alt=""></div>`
      : "";
    el.metaPanel.innerHTML = `${posterHtml}<div class="meta-body">${body}</div>${factsHtml}`;
    el.metaPanel.dataset.watchToken = String(resolveToken);
    const nextPoster = el.metaPanel.querySelector(".meta-poster img");
    if (preservedPoster && nextPoster && preservedPoster.getAttribute("src") === nextPoster.getAttribute("src")) {
      nextPoster.replaceWith(preservedPoster);
    }
    const ratingsHost = el.metaPanel.querySelector(".meta-ratings");
    if (canPreserveLetterboxd && ratingsHost && !ratingsHost.querySelector(".rt-lb")) {
      ratingsHost.appendChild(preservedLetterboxd);
    }
    if (isSeries) hideReviews();
    const posterHost = el.metaPanel.querySelector(".meta-poster");
    if (posterHost) {
      addCardBookmark(posterHost, target, {
        title,
        year,
        poster,
        rating: view.rating || {},
        movieLength: view.movieLength || null,
        isSeries,
      });
    }
    // Revealed before the synopsis is measured, and that order is the whole
    // point: `.hidden` is `display: none`, and a display:none element reports
    // scrollHeight and clientHeight as 0, so the overflow test below compared
    // 0 > 2 and never fired. On a cold load the "ещё" toggle simply never
    // appeared and the rest of the description was unreachable; opening another
    // title from inside the app hid the bug, because the panel was already
    // visible by then. Reading scrollHeight forces the reflow this needs.
    el.metaPanel.classList.remove("hidden");
    // Both of the measurements below need real boxes, so both come after the
    // reveal — and this one first, because it decides the height the other one
    // is then asked about.
    fitMetaSynopsis();
    // The synopsis is clamped rather than scrolled: a scroll region inside a
    // sidebar hides that there is more text and clips the last line mid-height.
    // The toggle only appears when the text is actually longer than the clamp.
    const descNode = el.metaPanel.querySelector(".meta-desc");
    const toggle = el.metaPanel.querySelector(".meta-desc-toggle");
    if (descNode && toggle && descNode.scrollHeight > descNode.clientHeight + 2) {
      toggle.classList.remove("hidden");
      toggle.addEventListener("click", () => {
        const open = descNode.classList.toggle("open");
        toggle.textContent = open ? "свернуть" : "ещё";
      });
    }
    fillLetterboxdBadge(view, target);
    scheduleWatchExtras(target);
  }

  // How many whole lines of synopsis fit beside the poster.
  //
  // The narrow layout stands the text column next to the poster, and letting it
  // run past the bottom leaves a notch of dead space beside the last lines.
  // Capping the column's height instead was worse: it cut through the middle of
  // a line of letters. Lines are the only unit that can be cut cleanly, so the
  // count is what gets computed — CSS cannot, because how many fit depends on
  // whether the title wrapped and whether this title has ratings at all.
  //
  // Written as a custom property rather than an inline line-clamp so that
  // `.meta-desc.open` still wins when the viewer expands it.
  function fitMetaSynopsis() {
    const panel = el.metaPanel;
    const desc = panel?.querySelector(".meta-desc");
    const poster = panel?.querySelector(".meta-poster");
    const body = panel?.querySelector(".meta-body");
    if (!desc || !poster || !body) return;
    if (!window.matchMedia?.("(max-width: 560px)").matches) {
      desc.style.removeProperty("--desc-lines");
      return;
    }
    const posterHeight = poster.getBoundingClientRect().height;
    if (!posterHeight) return;
    // Everything in the column that is not the synopsis.
    //
    // Summed from the children rather than taken as (column - synopsis), which
    // is what this did first and is circular: the grid stretches the column to
    // the height of the poster, so that subtraction returns whatever the
    // synopsis already happened to be and the count never moves off its
    // starting value. The toggle is out of flow on this layout and rightly
    // contributes nothing.
    const gap = parseFloat(getComputedStyle(body).rowGap) || 0;
    let others = 0;
    let inFlow = 0;
    for (const child of body.children) {
      if (child === desc) continue;
      const box = child.getBoundingClientRect();
      if (!box.height) continue;
      const style = getComputedStyle(child);
      if (style.position === "absolute" || style.position === "fixed") continue;
      others += box.height + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
      inFlow += 1;
    }
    others += gap * inFlow;
    const lineHeight = parseFloat(getComputedStyle(desc).lineHeight);
    if (!Number.isFinite(lineHeight) || lineHeight <= 0) return;
    const lines = Math.floor((posterHeight - others) / lineHeight);
    // Two lines even when the arithmetic says less: a title long enough to eat
    // the whole column is better slightly overhanging than reduced to nothing.
    desc.style.setProperty("--desc-lines", String(Math.max(2, lines)));
  }

  // The count depends on the width, so it is recomputed when the width changes —
  // rotating a phone is the ordinary case.
  let fitSynopsisTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(fitSynopsisTimer);
    fitSynopsisTimer = setTimeout(() => {
      if (el.metaPanel && !el.metaPanel.classList.contains("hidden")) fitMetaSynopsis();
    }, 150);
  });

  function linkImdbBadge(imdbId, target, token) {
    if (!imdbTitleUrl(imdbId) || isStale(token) || !state.currentTarget) return;
    if (keyFor(state.currentTarget) !== keyFor(target)) return;
    const imdbNode = el.metaPanel.querySelector(".rt-imdb");
    if (!imdbNode || imdbNode.tagName === "A") return;
    const link = document.createElement("a");
    link.className = `${imdbNode.className} kp-rating-link`;
    link.href = imdbTitleUrl(imdbId);
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.innerHTML = imdbNode.innerHTML;
    imdbNode.replaceWith(link);
  }

  // Appended after the panel is already on screen: the score is a network hop
  // and must never hold the sidebar back. Rendered on Letterboxd's own 0-5
  // scale — rescaling it to look like Кинопоиск would just misquote the source.
  function fillLetterboxdBadge(meta, target) {
    if (meta?.isSeries) return;
    const token = resolveToken;
    letterboxdImdbId(meta)
      .then(async (imdbId) => {
        if (!imdbId || !letterboxdWatchIsCurrent(target, token)) return null;
        linkImdbBadge(imdbId, target, token);
        const rating = await letterboxdRating(imdbId);
        return rating ? { ...rating, imdb: imdbId } : null;
      })
      .then((rating) => {
        if (!rating || !letterboxdWatchIsCurrent(target, token)) return;
        const host = el.metaPanel.querySelector(".meta-ratings");
        if (!host) return;
        if (host.querySelector(".rt-lb")) {
          renderReviews(rating.imdb, rating.slug, token).catch((error) => log("reviews-warn", error.message));
          return;
        }
        const href = rating.slug ? `https://letterboxd.com/film/${encodeURIComponent(rating.slug)}/` : "";
        const node = document.createElement(href ? "a" : "div");
        node.className = href ? "rt rt-lb kp-rating-link" : "rt rt-lb";
        // The tooltip keeps the true scale, since that is what the link opens.
        node.title = `${rating.r.toFixed(2)} из 5 на Letterboxd`;
        if (href) {
          node.href = href;
          node.target = "_blank";
          node.rel = "noopener noreferrer";
        }
        node.innerHTML = `<b>${escapeHtml(letterboxdOutOfTen(rating.r))}</b><span>Letterboxd</span>`;
        node.dataset.watchToken = String(token);
        node.dataset.targetKey = keyFor(target);
        host.appendChild(node);
        // The block below «Похожее» hangs off the same resolved id, so it costs
        // no second identity lookup.
        renderReviews(rating.imdb, rating.slug, token).catch((error) => log("reviews-warn", error.message));
      })
      .catch((error) => log("letterboxd-badge-warn", error.message));
  }

  function letterboxdWatchIsCurrent(target, token) {
    if (isStale(token) || !state.currentTarget || state.currentMeta?.isSeries) return false;
    return keyFor(state.currentTarget) === keyFor(target);
  }

  // Only the Kinopoisk path carries externalId. Every other source (lift:, zen:,
  // ort:, clps:) arrives with a kpId instead.
  //
  // A warm "meta" entry is read because the watch page fills it anyway, but a
  // cold one is deliberately not fetched: a rating badge is not worth spending
  // metered quota on, and spending it here is what made a spent quota take the
  // badge down along with search. Anything still unknown goes to the identity
  // layer, which is free.
  async function letterboxdImdbId(meta) {
    const direct = String(meta?.externalId?.imdb || "");
    if (/^tt\d{6,10}$/.test(direct)) return direct;

    const kpId = String(positiveInt(meta?.kpId) || "");
    if (kpId) {
      const warm = String(cacheGet("meta", kpId)?.externalId?.imdb || "");
      if (/^tt\d{6,10}$/.test(warm)) return warm;
    }

    try {
      return await window.alphyIdentity?.resolve({
        title: movieTitle(meta) || meta?.title || "",
        originalTitle: meta?.originalTitle || meta?.alternativeName || "",
        year: meta?.year || "",
        isSeries: !!meta?.isSeries,
      }) || "";
    } catch {
      return "";
    }
  }

  // =====================================================================
  // Watch-page enrichment: credits backfill + «Похожее»
  //
  // Both are deliberately post-playback and deduped per navigation. Neither is
  // allowed to delay the player, and neither re-requests anything the caches
  // already answer — opening the same title twice costs nothing.
  // =====================================================================
  let watchExtrasKey = "";

  // Every play* path seeds the watch head with a synthetic label so the page is
  // never blank while the source resolves. These are ids, not names, and must
  // never reach a title-based lookup.
  const PLACEHOLDER_TITLE_RE = /^(liftw|zenith|фильм|kpid)\s+\d+$/i;

  function isPlaceholderTitle(title) {
    return PLACEHOLDER_TITLE_RE.test(compact(title));
  }

  function scheduleWatchExtras(target) {
    const kpId = String(state.currentMeta?.kpId || target?.kpId || "");
    const key = `${keyFor(target)}|${kpId}`;
    if (!target || watchExtrasKey === key) return;
    // Most sources render twice: a placeholder head first, then the real payload.
    // With neither an id nor a name there is nothing to look anything up by, and
    // scheduling anyway just buys a duplicate run once the id lands.
    if (!kpId && isPlaceholderTitle(state.currentMeta?.title || target?.title || "")) return;
    watchExtrasKey = key;
    const token = resolveToken;
    scheduleIdle(() => {
      if (isStale(token)) return;
      runWatchExtras(target, kpId, token).catch((error) => log("watch-extras-warn", error.message));
    }, 1200);
  }

  async function runWatchExtras(target, knownKpId, token) {
    let kpId = knownKpId;
    if (!/^\d+$/.test(kpId)) {
      // Curated zen:/ort: items carry no Kinopoisk id until an admin fills their
      // metadata in. Resolving it by title once (cached 30 days) is what lets
      // those titles show credits and «Похожее» at all.
      const title = state.currentMeta?.title || target?.title || "";
      // The watch head carries a synthetic label ("LiftW 1143") until the source
      // answers. Searching Kinopoisk for it can only miss, and each miss spends a
      // call from the shared daily key-pool budget.
      if (!title || isPlaceholderTitle(title)) return;
      kpId = String(await window.alphyForYou?.resolveKpId?.(title, state.currentMeta?.year || target?.year) || "");
      if (isStale(token) || !/^\d+$/.test(kpId)) return;
      attachHistoryKpId(keyFor(target), kpId);
      if (state.currentMeta) state.currentMeta.kpId = kpId;
    }
    await Promise.all([
      backfillCredits(target, kpId, token).catch((error) => log("credits-warn", error.message)),
      renderSimilarRow(kpId, token).catch((error) => log("similar-warn", error.message)),
    ]);
  }

  // Usually runs for provider targets that arrived with only title/poster. It also
  // repairs a kp: page whose old search-summary cache masqueraded as full metadata.
  async function backfillCredits(target, kpId, token) {
    if (!/^\d+$/.test(kpId)) return;
    const current = state.currentMeta || {};
    const hasIdentity = /^tt\d{6,10}$/.test(String(current.externalId?.imdb || ""));
    const hasRatings = [current.rating?.kp, current.rating?.imdb].some((value) => Number(value) > 0);
    if ((current.genres || []).length && (current.directors || []).length && current.people?.directors?.length &&
        current.description && hasRatings && hasIdentity) return;
    const extras = await window.alphyForYou?.filmExtras?.(kpId);
    if (!extras || isStale(token) || !state.currentTarget) return;
    if (keyFor(state.currentTarget) !== keyFor(target)) return;
    const merged = mergeMetadata(state.currentMeta || {}, extras);
    state.currentMeta = merged;
    cacheMovieMetadata(kpId, mergeMetadata(cacheGet("meta", kpId) || {}, extras));
    renderMeta(merged, state.currentTarget);
    recordOpen(state.currentTarget);
  }

  async function renderSimilarRow(kpId, token) {
    if (!el.similarSection || !el.similarRow) return;
    if (!/^\d+$/.test(kpId)) return;
    const items = await window.alphyForYou?.similarRow?.(kpId);
    if (!items?.length || isStale(token)) return;

    // Give enrichment a short head start. If it is cold, paint useful cards at
    // 220 ms and patch their text/rating nodes in place later; never replace the
    // visible row, which would reset hover and make the shelf blink.
    const enrichTask = window.alphyForYou?.enrichSimilarRow?.(kpId);
    const enriched = enrichTask
      ? await settleWithin(Promise.resolve(enrichTask).catch(() => null), 220)
      : null;
    if (isStale(token)) return;
    paintSimilarRow(enriched?.length ? enriched : items, token);
    if (!enriched?.length && enrichTask) {
      Promise.resolve(enrichTask).then((late) => {
        if (late?.length && !isStale(token)) patchCardRowMetadata(el.similarRow, late);
      }).catch(() => {});
    }
  }

  function patchCardRowMetadata(grid, items) {
    const byId = new Map((items || []).map((item) => [
      String(item?.kpId || item?.target?.kpId || ""), item,
    ]));
    for (const card of [...(grid?.querySelectorAll?.(".card[data-kp-id]") || [])]) {
      const item = byId.get(String(card.dataset.kpId || ""));
      if (!item) continue;
      if (item.year) card.dataset.year = String(item.year).slice(0, 4);
      const meta = card.querySelector(".cmeta");
      if (meta) meta.textContent = [item.year, item.isSeries ? "сериал" : "фильм"].filter(Boolean).join(" · ");
      const values = card.querySelectorAll(".hover-rating-value");
      if (values[0]) values[0].textContent = formatRating(item.rating?.imdb);
      if (values[1]) values[1].textContent = formatRating(item.rating?.kp);
      const imdb = item.externalId?.imdb || item.imdbId || "";
      if (/^tt\d{6,10}$/.test(String(imdb))) card.dataset.imdb = imdb;
      setCardDuration(card, item.movieLength, item.isSeries);
    }
    fillGridLetterboxd(grid);
  }

  function paintSimilarRow(items, token) {
    if (isStale(token)) return;
    const frag = document.createDocumentFragment();
    for (const item of items) {
      // A recommendation that is already curated opens through its resolved
      // target — instant playback instead of a fresh kp resolve.
      const ready = window.alphyCatalog?.findReady?.(item.title, item.year, item.isSeries);
      const entry = ready ? { ...ready, kpId: ready.kpId || String(item.target?.kpId || "") } : item;
      let card = null;
      card = makeCard({
        title: entry.title,
        sub: [entry.year, entry.isSeries ? "сериал" : "фильм"].filter(Boolean).join(" · "),
        poster: entry.poster,
        imdb: entry.externalId?.imdb || entry.imdbId || "",
        originalTitle: entry.originalTitle || "",
        rating: entry.rating,
        movieLength: entry.movieLength,
        isSeries: entry.isSeries,
        bookmark: { target: entry.target, details: entry },
        recommendation: entry,
        onClick: () => openRecommendationItem(entry),
        onRemove: () => {
          window.alphyForYou?.hide?.(item.target?.kpId);
          card?.remove();
          if (!el.similarRow?.children.length) hideSimilarRow();
        },
      });
      frag.appendChild(card);
    }
    el.similarRow.replaceChildren(frag);
    el.similarSection.classList.remove("hidden");
    setSimilarCollapsed(readSimilarCollapsed(), { persist: false });
  }

  function readSimilarCollapsed() {
    try { return localStorage.getItem(STORE_SIMILAR_COLLAPSED) === "1"; }
    catch { return false; }
  }

  function setSimilarCollapsed(collapsed, { persist = true } = {}) {
    el.similarSection?.classList.toggle("collapsed", collapsed);
    el.similarToggle?.setAttribute("aria-expanded", collapsed ? "false" : "true");
    if (el.similarToggle) el.similarToggle.textContent = collapsed ? "Показать" : "Скрыть";
    if (persist) {
      try { localStorage.setItem(STORE_SIMILAR_COLLAPSED, collapsed ? "1" : "0"); } catch { /* ignore */ }
    }
  }

  function hideSimilarRow() {
    el.similarSection?.classList.add("hidden");
    el.similarRow?.replaceChildren();
  }

  function hideReviews() {
    el.reviewsSection?.classList.add("hidden");
    el.reviewsList?.replaceChildren();
    if (el.reviewsLink) {
      el.reviewsLink.removeAttribute("href");
      el.reviewsLink.removeAttribute("target");
      el.reviewsLink.removeAttribute("rel");
    }
  }

  // Text arrives already stripped of markup and control characters by the
  // resolver, but it is still someone's prose from the open internet, so it only
  // ever reaches the page as a text node.
  function renderReview(item) {
    const row = document.createElement("li");
    row.className = "review";
    const top = document.createElement("div");
    top.className = "review-top";
    if (item.a) {
      const author = document.createElement("span");
      author.className = "review-author";
      author.textContent = item.a;
      top.appendChild(author);
    }
    if (item.r > 0) {
      const score = document.createElement("span");
      score.className = "review-score";
      score.textContent = `${Number(item.r).toFixed(Number(item.r) % 1 ? 1 : 0)}/5`;
      top.appendChild(score);
    }
    if (top.childNodes.length) row.appendChild(top);

    const text = document.createElement("p");
    text.className = "review-text";
    text.textContent = item.t;
    if (item.c) {
      // Letterboxd hides the rest behind its own "more"; saying so is honest and
      // the footer link goes where the rest of it is.
      const cut = document.createElement("span");
      cut.className = "review-cut";
      cut.textContent = " …";
      text.appendChild(cut);
    }

    if (item.s) {
      // A spoiler stays behind one deliberate click. Showing it and apologising
      // afterwards is not an option on a page about a film someone is choosing.
      const reveal = document.createElement("button");
      reveal.className = "review-spoiler";
      reveal.type = "button";
      reveal.textContent = "Отзыв со спойлером — показать";
      reveal.addEventListener("click", () => reveal.replaceWith(text), { once: true });
      row.appendChild(reveal);
    } else {
      row.appendChild(text);
    }
    return row;
  }

  async function renderReviews(imdbId, slug, token) {
    if (!el.reviewsSection || !el.reviewsList || state.currentMeta?.isSeries) return;
    const list = await letterboxdReviews(imdbId);
    if (!list?.length || isStale(token) || state.currentMeta?.isSeries) return;
    const frag = document.createDocumentFragment();
    for (const item of list) frag.appendChild(renderReview(item));
    el.reviewsList.replaceChildren(frag);
    if (slug && el.reviewsLink) {
      el.reviewsLink.href = `https://letterboxd.com/film/${encodeURIComponent(slug)}/reviews/by/activity/`;
      el.reviewsLink.target = "_blank";
      el.reviewsLink.rel = "noopener noreferrer";
    }
    el.reviewsSection.classList.remove("hidden");
  }

  // =====================================================================
  // Playback — Ortified, native
  //
  // Ortified is the same service as LiftW under a different hostname: its MSX
  // descriptor calls itself "lift", it serves the identical TV bundle pointing
  // at //api.lift3.ws/v2, and its ids resolve in LiftW's /info to the same
  // titles. So its embed is the same player-venom `makePlayer` object we already
  // parse, and it can play natively instead of inside an iframe.
  //
  // Three things that buys, in order of what a viewer notices:
  //  - resume works. The iframe player could be told nothing, so position was
  //    recorded and never restored.
  //  - no iframe <video>, which has no hardware overlay and micro-stutters on
  //    TV and projector browsers.
  //  - the media plane stops carrying our origin. The cleanroom iframe is a
  //    srcdoc with no sandbox attribute, so it inherits alphy.tv and every CDN
  //    request it made said so; routed through the opaque broker it says null.
  //
  // The embed itself is fetched straight from the browser through the opaque
  // sandbox — no relay. Unlike api.liftw.ws, api.ortified.ws is reachable and
  // sends CORS, so adding a server hop would create exposure rather than remove
  // it. There is deliberately no worker fallback here for the same reason.
  // =====================================================================
  const ORT_PARSED_CACHE_MS = 20 * 60e3;
  const ortParsedCache = new Map();
  const ortParsedInflight = new Map();

  async function resolveOrtifiedParsed(embedUrl, { force = false, wantSeasons = false } = {}) {
    const key = canonicalOrtEmbedUrl(embedUrl);
    if (!force) {
      const cached = ortParsedCache.get(key);
      if (cached && cached.expiresAt > Date.now() && zenithParsedUsable(cached.value, wantSeasons)) {
        return cached.value;
      }
    }
    const inflightKey = `${key}|${wantSeasons ? "s" : "-"}|${force ? "f" : "-"}`;
    const existing = ortParsedInflight.get(inflightKey);
    if (existing) return existing;
    const pending = (async () => {
      const html = await fetchCachedEmbedText(embedUrl, {
        preferSandbox: true,
        directFallback: false,
        label: "ortified",
        timeoutMs: 12000,
        sandboxTimeoutMs: 12000,
      });
      const value = parseZenithEmbed(html);
      if (!zenithParsedUsable(value, wantSeasons)) {
        throw new Error("Ortified embed не отдал dash/hls");
      }
      // parseZenithEmbed returns sources/meta/playlist but not subtitles — for a
      // movie those live in the same `cc:` array LiftW reads, and without this
      // the native path would quietly play without them. Episodes carry their
      // own, which normalizeSerialSeasons already picks up.
      value.textTracks = liftwTextTracks(html);
      ortParsedCache.set(key, { value, expiresAt: Date.now() + ORT_PARSED_CACHE_MS });
      return value;
    })().finally(() => ortParsedInflight.delete(inflightKey));
    ortParsedInflight.set(inflightKey, pending);
    return pending;
  }

  // Errors and logs get the host only: the signed media URL is a credential.
  function safeMediaHost(value) {
    try { return new URL(String(value)).hostname; } catch { return "?"; }
  }

  function dropOrtifiedParsed(embedUrl) {
    ortParsedCache.delete(canonicalOrtEmbedUrl(embedUrl));
  }

  async function playOrtifiedNative(embedUrl, target, token, opts = {}) {
    if (isStale(token)) return;
    showPlayerLoading();
    const shakaTask = ensureShaka();
    shakaTask.catch(() => {});
    // Warming happens inside the broker document: a top-level preconnect would
    // open the connection as alphy.tv, which is the leak we are here to close.
    warmLiftwConnections();

    const parsed = await resolveOrtifiedParsed(embedUrl, {
      force: !!opts.force,
      wantSeasons: !!(target?.isSeries || opts.serialSelection),
    });
    if (isStale(token)) return;

    const seasons = normalizeSerialSeasons(parsed.playlist?.seasons);
    const requested = opts.serialSelection || parsed.playlist?.current;
    const selection = chooseSerialSelection(seasons, requested);
    const episode = findSerialEpisode(seasons, selection);
    const sources = episode?.sources || parsed.sources;
    const media = bestZenithSource(sources);
    if (!media) throw new Error("Ortified embed не отдал dash/hls");
    // The broker only rewrites hosts it recognises; anything else would be
    // fetched by the page itself and would carry our origin to the CDN. A
    // silent leak is worse than the iframe, so an unroutable host refuses the
    // native path and lets the caller fall back.
    if (!isLiftwMediaUrl(media.url)) {
      throw new Error(`Ortified: медиа-хост вне брокера (${safeMediaHost(media.url)})`);
    }

    const histKey = opts.histKey || keyFor(target);
    const serial = selection
      ? { provider: "ort", embedUrl, histKey, seasons, selection, switching: false }
      : null;

    state.sources = sources;
    // Ortified is LiftW, so dub names ride on the EPISODE, not the document — a
    // season can change studios mid-run. Reading only the document level left a
    // series showing the manifest's own ru0..ru7 instead of LostFilm/Кубик в
    // кубе/Eng.Original. A movie has no episode and keeps the document names.
    state.audioNames = (episode?.audioNames?.length ? episode.audioNames : parsed.meta.audioNames) || [];
    state.blockedAudioNames = parsed.meta.blockedAudioNames || [];
    if (selection) {
      target.season = selection.season;
      target.episode = selection.episode;
      target.isSeries = true;
      persistSerialSelection(target, selection);
    }
    await shakaTask;
    if (isStale(token)) return;
    try {
      await playShaka(media.url, media.kind, token, {
        resume: opts.resume ?? resumePosition(histKey),
        historyKey: histKey,
        audioPreference: opts.audioPreference,
        audioLang: opts.audioLang,
        subtitlePreference: opts.subtitlePreference,
        textTracks: episode?.textTracks?.length ? episode.textTracks : parsed.textTracks,
        serial,
        opaqueMedia: "liftw",
      });
    } catch (error) {
      // A cached parse can only be wrong about one thing: a signature that
      // rotated between the resolve and the click. Re-mint once, then let it go.
      if (opts.force || isStale(token)) throw error;
      log("ort-source-refresh", { message: error.message });
      dropOrtifiedParsed(embedUrl);
      await playOrtifiedNative(embedUrl, target, token, { ...opts, force: true });
      return;
    }
    if (isStale(token)) return;
    startTracking(histKey, target);
  }

  async function switchOrtSelection(nextSelection) {
    const context = state.serial;
    const target = state.currentTarget;
    if (!context || context.provider !== "ort" || !target || context.switching) return;
    const selection = chooseSerialSelection(context.seasons, nextSelection);
    if (!selection || sameSerialSelection(selection, context.selection)) return;
    const episode = findSerialEpisode(context.seasons, selection);
    const media = bestZenithSource(episode?.sources);
    // Same guard as the first episode: a host the broker cannot rewrite would
    // be fetched by the page and undo the null origin mid-series.
    if (!media || !isLiftwMediaUrl(media.url)) return;

    const token = resolveToken;
    const audioPreference = currentAudioPreference() || savedAudioPreference(context.histKey || keyFor(target));
    const subtitlePreference = currentSubtitlePreference() || savedSubtitlePreference(context.histKey || keyFor(target));
    context.switching = true;
    renderTracks();
    await teardownPlayer();
    showPlayerLoading();
    persistSerialSelection(target, selection, true);

    try {
      if (isStale(token) || keyFor(state.currentTarget) !== keyFor(target)) return;
      const nextContext = { ...context, selection, switching: false };
      state.sources = episode.sources;
      // Same reason as above: the next episode may be voiced by other studios.
      state.audioNames = episode.audioNames?.length ? episode.audioNames : state.audioNames;
      await playShaka(media.url, media.kind, token, {
        resume: 0,
        historyKey: context.histKey || keyFor(target),
        audioPreference,
        subtitlePreference,
        textTracks: episode?.textTracks || [],
        serial: nextContext,
        // The whole episode switch would otherwise fetch straight from the page
        // and undo the null origin the first episode was played with.
        opaqueMedia: "liftw",
      });
      if (isStale(token)) return;
      startTracking(context.histKey || keyFor(target), target);
    } catch (error) {
      if (isStale(token)) return;
      log("ort-episode-refresh", { selection, message: error.message });
      try {
        await playOrtifiedNative(context.embedUrl, target, token, {
          histKey: context.histKey || keyFor(target),
          resume: 0,
          audioPreference,
          subtitlePreference,
          serialSelection: selection,
          force: true,
        });
      } catch (refreshError) {
        if (isStale(token)) return;
        showError(new Error("Не удалось загрузить выбранную серию"));
        log("ort-episode-switch-error", { selection, message: refreshError.message });
      }
    }
  }

  // =====================================================================
  // Playback — Ortified cleanroom iframe (fallback)
  // =====================================================================
  async function playOrtifiedCleanroom(embedUrl, target, token) {
    if (isStale(token)) return;
    showPlayerLoading();
    let html;
    try {
      html = await fetchCachedEmbedText(embedUrl, { preferSandbox: true, label: "ortified" });
    } catch (error) {
      // api.ortified.ws answers 422 to any request from a non-Russian IP — for a
      // user who normally streams from RU that means a VPN was left on. Surface the
      // actionable hint instead of the raw "XHR 422".
      if (/\b422\b/.test(String(error?.message || error))) {
        throw new Error("Попробуйте выключить VPN");
      }
      throw error;
    }
    if (isStale(token)) return;
    const sanitized = sanitizeOrtifiedHtml(html, embedUrl, "cleanroom-block");
    if (!sanitized.stats.ok) throw new Error("В Ortified HTML нет makePlayer");
    const iframe = document.createElement("iframe");
    iframe.allow = "autoplay; fullscreen; encrypted-media; picture-in-picture";
    iframe.allowFullscreen = true;
    iframe.referrerPolicy = "no-referrer";
    iframe.srcdoc = sanitized.html;
    el.playerHost.replaceChildren(iframe);
    el.serialPanel.classList.add("hidden");
    el.trackPanel.classList.add("hidden");
    await new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      iframe.addEventListener("load", done, { once: true });
      setTimeout(done, 1800);
    });
    if (!isStale(token)) markPlayerReady();
    log("ortified", "cleanroom loaded", sanitized.stats);
  }

  // =====================================================================
  // Playback — Zenith via Shaka
  // =====================================================================
  function zenithBrowserFetchBlocked() {
    try { return Number(localStorage.getItem("alphy.zenithBrowserBlockedUntil") || 0) > Date.now(); }
    catch { return false; }
  }

  function rememberZenithBrowserFetch(blocked) {
    try {
      if (blocked) localStorage.setItem("alphy.zenithBrowserBlockedUntil", String(Date.now() + ZENITH_DIRECT_BLOCK_MS));
      else localStorage.removeItem("alphy.zenithBrowserBlockedUntil");
    } catch { /* best-effort optimization */ }
  }

  function zenithIdOf(embedUrl) {
    return String(embedUrl || "").match(/\/movie\/(\d+)/i)?.[1] || "";
  }

  // A parse is usable when it can actually start playback. A series additionally
  // needs its season list, otherwise the episode picker would come up empty and
  // the cheap cached copy would be worse than a fresh resolve.
  function zenithParsedUsable(value, wantSeasons) {
    if (!value) return false;
    const hasSource = !!(value.sources?.dash || value.sources?.hls || value.sources?.dasha);
    const hasSeasons = !!value.playlist?.seasons?.length;
    if (!hasSource && !hasSeasons) return false;
    return wantSeasons ? hasSeasons : true;
  }

  function readZenithParsed(id, wantSeasons) {
    const memo = zenithParsedCache.get(id);
    if (memo?.expiresAt > Date.now() && zenithParsedUsable(memo.value, wantSeasons)) return memo.value;
    const stored = cacheGet("zenith", id);
    if (zenithParsedUsable(stored, wantSeasons)) {
      zenithParsedCache.set(id, { value: stored, expiresAt: Date.now() + ZENITH_PARSED_CACHE_MS });
      return stored;
    }
    return null;
  }

  function writeZenithParsed(id, value) {
    if (!id || !zenithParsedUsable(value, false)) return value;
    zenithParsedCache.set(id, { value, expiresAt: Date.now() + ZENITH_PARSED_CACHE_MS });
    if (zenithParsedCache.size > 12) zenithParsedCache.delete(zenithParsedCache.keys().next().value);
    cacheSet("zenith", id, value, TTL.zenith);
    return value;
  }

  function dropZenithParsed(embedUrl) {
    const id = zenithIdOf(embedUrl);
    if (!id) return;
    zenithParsedCache.delete(id);
    try { localStorage.removeItem(`${CACHE_PREFIX}zenith:${id}`); } catch { /* ignore */ }
  }

  // Single entry point for "give me this embed's sources": memory -> localStorage
  // -> one direct browser attempt -> resolver. In-flight requests are shared, so a
  // hover prefetch that is still running is JOINED by the click instead of being
  // raced by a second identical resolve.
  async function resolveZenithParsed(embedUrl, { force = false, wantSeasons = false } = {}) {
    const id = zenithIdOf(embedUrl);
    if (!id) throw new Error("Не удалось извлечь Zenith id");
    if (!force) {
      const cached = readZenithParsed(id, wantSeasons);
      if (cached) return cached;
    }
    const inflightKey = `${id}|${wantSeasons ? "s" : "-"}|${force ? "f" : "-"}`;
    const existing = zenithParsedInflight.get(inflightKey);
    if (existing) return existing;
    const pending = (async () => {
      let parsed = null;
      if (!force && !zenithBrowserFetchBlocked()) {
        try {
          // A browser that can reach Zenith directly normally answers quickly.
          // Keep that viewer-IP fast path, but run it from an opaque sandbox so
          // Zenith cannot learn the Alphy origin.
          const html = await fetchThirdPartyText(embedUrl, {
            preferSandbox: true,
            directFallback: false,
            timeoutMs: ZENITH_BROWSER_FAST_WINDOW_MS,
            label: "zenith",
          });
          const value = parseZenithEmbed(html);
          rememberZenithBrowserFetch(false);
          if (zenithParsedUsable(value, wantSeasons)) parsed = value;
        } catch (error) {
          rememberZenithBrowserFetch(true);
          log("zenith-browser-fallback", { message: error.message });
        }
      }
      if (!parsed) parsed = await fetchZenithFromResolver(id, force);
      return writeZenithParsed(id, parsed);
    })().finally(() => zenithParsedInflight.delete(inflightKey));
    zenithParsedInflight.set(inflightKey, pending);
    return pending;
  }

  async function fetchZenithFromResolver(id, force = false) {
    // The resolver answers cached hits with `public, max-age=300`; letting the
    // browser honour that (instead of no-store) makes a re-open free. A forced
    // refresh exists precisely to defeat every cache, so it reloads.
    const data = await resolverJson(`/zenith?id=${encodeURIComponent(id)}`, {
      fetchCache: force ? "reload" : "default",
    });
    if (!data.hasSources) throw new Error("Worker Zenith fallback не отдал источники");
    return {
      sources: data.sources || {},
      meta: data.meta || {},
      playlist: data.playlist || { current: null, seasons: [] },
    };
  }

  async function playZenithEmbed(embedUrl, target, token, opts = {}) {
    if (isStale(token)) return;
    showPlayerLoading();
    state.zenithEmbedUrl = embedUrl;
    const shakaTask = ensureShaka();
    shakaTask.catch(() => {});
    const parsed = await resolveZenithParsed(embedUrl, {
      force: !!opts.forceWorker,
      wantSeasons: !!(opts.forceSeries || target?.isSeries || opts.serialSelection),
    });
    if (isStale(token)) return;

    const seasons = normalizeSerialSeasons(parsed.playlist?.seasons);
    const requested = opts.serialSelection || parsed.playlist?.current;
    const selection = chooseSerialSelection(seasons, requested);
    const episode = findSerialEpisode(seasons, selection);
    const sources = episode?.sources || parsed.sources;
    const media = bestZenithSource(sources);
    const serial = selection
      ? {
          provider: "zenith",
          embedUrl,
          histKey: opts.histKey || keyFor(target),
          seasons,
          selection,
          switching: false,
        }
      : null;

    state.sources = sources;
    state.audioNames = (episode?.audioNames?.length ? episode.audioNames : parsed.meta.audioNames) || [];
    state.blockedAudioNames = parsed.meta.blockedAudioNames || [];
    if (!media) throw new Error("Zenith embed не отдал dash/hls");
    if (selection) persistSerialSelection(target, selection);
    await shakaTask;
    if (isStale(token)) return;
    try {
      await playShaka(media.url, media.kind, token, {
        resume: opts.resume || 0,
        historyKey: opts.histKey || keyFor(target),
        audioPreference: opts.audioPreference,
        audioLang: opts.audioLang,
        subtitlePreference: opts.subtitlePreference,
        textTracks: episode?.textTracks || parsed.textTracks || [],
        serial,
      });
    } catch (error) {
      // The only way a cached parse can hurt is a signature that expired between
      // the resolve and the click. Re-mint once, then let the error stand.
      if (opts.forceWorker || isStale(token)) throw error;
      log("zenith-source-refresh", { message: error.message });
      dropZenithParsed(embedUrl);
      await playZenithEmbed(embedUrl, target, token, { ...opts, forceWorker: true });
      return;
    }
    if (isStale(token)) return;
    if (opts.histKey) startTracking(opts.histKey, target);
  }

  async function playShaka(url, kind, token, opts = {}) {
    if (isStale(token)) return;
    const historyKey = opts.historyKey || opts.serial?.histKey || keyFor(state.currentTarget);
    const audioPreference =
      cleanAudioPreference(opts.audioPreference) ||
      cleanAudioPreference(opts.audioLang) ||
      savedAudioPreference(historyKey);
    const subtitlePreference =
      cleanSubtitlePreference(opts.subtitlePreference) ||
      savedSubtitlePreference(historyKey);
    await ensureShaka();
    if (isStale(token)) return;
    await teardownPlayer();
    state.playbackHistoryKey = historyKey;
    state.audioPreference = audioPreference;
    state.subtitlePreference = subtitlePreference;
    state.subtitleOffset = subtitlePreference?.offset || 0;
    state.opravar = opts.opravar || null;
    state.serial = opts.serial || null;
    resetSubtitleRequest();
    const video = document.createElement("video");
    video.controls = true;
    video.playsInline = true;
    mountPaused(video);
    video.crossOrigin = "anonymous";
    video.playbackRate = state.playbackRate;
    if (isStale(token)) return;
    el.playerHost.replaceChildren(video);
    state.videoEl = video;

    if (!window.shaka) throw new Error("Shaka не загрузился");
    shaka.polyfill.installAll();
    if (!shaka.Player.isBrowserSupported()) throw new Error("Shaka: браузер не поддерживается");

    const player = new shaka.Player();
    state.player = player;
    await player.attach(video);
    if (opts.opaqueMedia === "liftw") installLiftwOpaqueNetworking(player);
    player.configure({
      streaming: {
        bufferingGoal: 20,
        rebufferingGoal: 2,
        bufferBehind: 30,
        retryParameters: { maxAttempts: 3, baseDelay: 450, backoffFactor: 1.5 },
      },
      manifest: { dash: { ignoreMinBufferTime: true } },
      abr: {
        enabled: true,
        defaultBandwidthEstimate: initialBandwidthEstimate(4_000_000),
        switchInterval: 4,
        bandwidthUpgradeTarget: 0.8,
        bandwidthDowngradeTarget: 0.95,
      },
    });
    player.addEventListener("trackschanged", renderTracks);
    player.addEventListener("variantchanged", renderTracks);
    player.addEventListener("textchanged", renderTracks);
    await player.load(url);
    if (isStale(token)) {
      await player.destroy().catch(() => {});
      if (state.player === player) { state.player = null; state.videoEl = null; }
      return;
    }
    for (const track of opts.textTracks || []) {
      try {
        await player.addTextTrackAsync(track.url, track.language || "und", "subtitles", "text/vtt", "", track.label || track.language || "subs");
      } catch (error) {
        log("subtitle-warn", track.url, error.message);
      }
    }
    // Restore the actual dub name first. Positional tags such as rus1 are only a
    // compatibility fallback: providers are allowed to reorder studios between
    // episodes while keeping the same technical tags.
    let matchedAudioChoice = null;
    if (audioPreference) {
      try {
        const choices = shakaAudioChoices(player.getVariantTracks?.() || [], true);
        const match = chooseAudioPreference(choices, audioPreference);
        if (match) {
          matchedAudioChoice = match;
          selectShakaAudio(player, match.track);
        }
      } catch { /* ignore */ }
    }
    const activeChoice = shakaAudioChoices(player.getVariantTracks?.() || [], true)
      .find((choice) => choice.track.active);
    if (activeChoice?.blocked) {
      const fallback = shakaAudioChoices(player.getVariantTracks?.() || []).find(Boolean);
      if (fallback) selectShakaAudio(player, fallback.track);
    }
    if (state.audioPreference && !state.audioPreference.name && matchedAudioChoice) {
      // Transparently upgrade legacy history that only stored `rus1` to the
      // human studio name while the old episode still gives us that mapping.
      state.audioPreference = audioPreferenceForChoice(matchedAudioChoice);
    } else if (!state.audioPreference) {
      const selected = shakaAudioChoices(player.getVariantTracks?.() || [], true)
        .find((choice) => choice.track.active && !choice.blocked);
      state.audioPreference = audioPreferenceForChoice(selected);
    }

    let subtitleMatched = false;
    if (subtitlePreference) {
      try {
        if (!subtitlePreference.enabled) {
          player.setTextTrackVisibility(false);
        } else {
          const texts = (player.getTextTracks?.() || [])
            .filter((track) => !state.staleTextTrackIds.includes(track.id));
          const match = chooseSubtitleTrack(texts, subtitlePreference);
          if (match) {
            player.selectTextTrack(match);
            player.setTextTrackVisibility(true);
            subtitleMatched = true;
          } else {
            player.setTextTrackVisibility(false);
          }
        }
      } catch { /* ignore */ }
    }
    if (opts.resume > 5) { try { video.currentTime = opts.resume; } catch { /* ignore */ } }
    video.playbackRate = state.playbackRate;
    renderTracks();
    markPlayerReady();
    startPlaybackIfAllowed(video, { resume: opts.resume > 5 });
    // A viewer who had subtitles enabled should not have to stop at every new
    // episode. If the manifest has no exact or same-language track, fetch that
    // episode's subtitles asynchronously while video playback continues.
    if (subtitlePreference?.enabled && !subtitleMatched) {
      requestSubtitles({ preference: subtitlePreference, background: true }).catch(() => {});
    }
  }

  function selectHighestShakaVariant(player, preferredLanguage = "") {
    const variants = player?.getVariantTracks?.() || [];
    if (!variants.length) return null;
    const active = variants.find((track) => track.active);
    const language = preferredLanguage || active?.language || "";
    const candidates = variants.filter((track) => !language || track.language === language);
    const best = [...(candidates.length ? candidates : variants)].sort(
      (a, b) => (b.height || 0) - (a.height || 0) || (b.bandwidth || 0) - (a.bandwidth || 0),
    )[0];
    if (!best) return null;
    player.configure({ abr: { enabled: false } });
    player.selectVariantTrack(best, true);
    return best;
  }

  // The stable identity of a dub. LiftW's DASH puts the suffixed name straight
  // into lang= ("rus1"), while its HLS puts the same string in NAME/label and
  // leaves LANGUAGE a plain "ru" — so preferring the label makes a remembered
  // choice survive a switch between the two ladders.
  function audioTag(track) {
    return track?.label || track?.language || "";
  }

  // selectAudioLanguage() cannot express *which* dub was clicked when several
  // share a language, so switch by label where one exists. selectVariantsByLabel
  // re-picks the variant with ABR still enabled, unlike selectVariantTrack.
  function selectShakaAudio(player, track) {
    const label = track?.label || "";
    if (label && typeof player?.selectVariantsByLabel === "function") {
      try {
        player.selectVariantsByLabel(label);
        return;
      } catch { /* fall through to the language API */ }
    }
    const keepAuto = shakaAbrEnabled(player);
    player.selectAudioLanguage(track.language, (track.roles || [])[0]);
    if (!keepAuto) selectHighestShakaVariant(player, track.language);
  }

  function shakaAbrEnabled(player) {
    try { return player?.getConfiguration?.().abr?.enabled !== false; }
    catch { return true; }
  }

  function startTracking(histKey, target) {
    stopTracking(false);
    state.trackContext = { histKey, target };
    state.trackInterval = setInterval(flushTrackedProgress, TIZEN_VIDEO_MODE ? 30000 : 5000);
  }

  function flushTrackedProgress() {
    const tracked = state.trackContext;
    const v = state.videoEl;
    if (!tracked || !v) return;
    const { histKey, target } = tracked;
    const dur = v.duration;
    const cur = v.currentTime;
    if (!dur || !isFinite(dur) || dur <= 0) return;
    const audioPreference = currentAudioPreference(state.player);
    const audioLang = audioPreference?.tag || audioPreference?.language || soapActiveAudioLang();
    const entry = {
      key: histKey,
      kind: target.kind,
      target: cleanTarget(target),
      title: target.title || "",
      poster: target.poster || "",
      year: target.year || "",
      rating: state.currentMeta?.rating || undefined,
      movieLength: state.currentMeta?.movieLength || undefined,
      isSeries: state.currentMeta?.isSeries ?? target.isSeries ?? false,
      kpId: historyKpId(target, state.currentMeta || {}),
      meta: historyMetaSnapshot(state.currentMeta || {}, target),
      position: cur,
      duration: dur,
      progress: cur / dur,
    };
    if (audioLang) entry.audioLang = audioLang;
    if (audioPreference) entry.audioPreference = audioPreference;
    if (state.subtitlePreference) entry.subtitlePreference = cleanSubtitlePreference(state.subtitlePreference);
    if (state.collaps?.selection) entry.collapsSelection = cleanCollapsSelection(state.collaps.selection);
    recordHistory(entry);
  }

  function stopTracking(flush = false) {
    if (flush) flushTrackedProgress();
    if (state.trackInterval) { clearInterval(state.trackInterval); state.trackInterval = null; }
    state.trackContext = null;
  }

  function markPlayerReady() {
    state.playerReady = true;
    window.dispatchEvent(new CustomEvent("alphy:player-ready", {
      detail: { ready: true },
    }));
  }

  function resetSubtitleRequest() {
    state.subtitleRequest = { loading: false, error: "", message: "" };
  }

  function revokeSubtitleObjectUrls() {
    for (const url of state.subtitleObjectUrls || []) {
      try { URL.revokeObjectURL(url); } catch { /* ignore */ }
    }
    state.subtitleObjectUrls = [];
    state.loadedSubs = [];
    state.subtitleOffset = 0;
    state.subtitleOffsetOpen = false;
    state.subtitleOffsetBusy = false;
    state.staleTextTrackIds = [];
  }

  // Frame snapshots are gone. drawImage(video)+toDataURL forces a synchronous
  // GPU readback, and it ran on loadeddata/playing/pause/seeked — so on a weak
  // device every rebuffer fired a capture, and the capture caused the next
  // rebuffer. A thumbnail on the continue card is not worth a stutter every
  // second on a projector; those cards fall back to the poster, which every
  // entry already has.

  // Position reports from the Ortified cleanroom iframe (see progressHook). We can't
  // resume the embedded player, but we record where the viewer stopped so the
  // homepage card shows progress for Ortified titles too.
  function onOrtProgress(event) {
    const data = event.data || {};
    if (!data.alphyOrtProgress) return;
    const target = state.currentTarget;
    if (!target || target.kind !== "ort") return;
    const { position, duration, snapshot } = data;
    if (!duration || !isFinite(duration) || duration <= 0) return;
    const hasSnapshot = typeof snapshot === "string" && snapshot.startsWith("data:image/jpeg");
    state.pendingOrtEntry = {
      key: keyFor(target),
      kind: "ort",
      target: cleanTarget(target),
      title: target.title || "",
      poster: target.poster || "",
      year: target.year || "",
      rating: state.currentMeta?.rating || undefined,
      movieLength: state.currentMeta?.movieLength || undefined,
      isSeries: state.currentMeta?.isSeries ?? target.isSeries ?? false,
      position,
      duration,
      progress: position / duration,
      ...(hasSnapshot ? { snapshot } : {}),
    };
    // recordHistory is a synchronous parse+stringify+localStorage write of the
    // whole list. The srcdoc player shares this event loop, so doing it on every
    // ~4s report visibly freezes the video on weak TV browsers. Coalesce to ~15s
    // (snapshot-bearing ticks always land so the continue-card thumbnail refreshes)
    // and flush the newest on teardown so the last position still persists.
    if (!hasSnapshot && Date.now() - state.lastOrtWriteAt < 15000) return;
    flushOrtProgress();
  }

  function flushOrtProgress() {
    const entry = state.pendingOrtEntry;
    if (!entry) return;
    state.pendingOrtEntry = null;
    state.lastOrtWriteAt = Date.now();
    recordHistory(entry);
  }

  async function teardownPlayer() {
    stopTracking(false);
    flushOrtProgress();
    teardownCollapsPlayer();
    if (state.player) {
      await state.player.destroy().catch(() => {});
      state.player = null;
    }
    if (state.hls) {
      try { state.hls.destroy(); } catch { /* ignore */ }
      state.hls = null;
    }
    revokeSubtitleObjectUrls();
    resetSubtitleRequest();
    state.videoEl = null;
    state.opravar = null;
    state.serial = null;
    state.rezka = null;
    state.playbackHistoryKey = "";
    state.audioPreference = null;
    state.subtitlePreference = null;
    state.playerReady = false;
    window.dispatchEvent(new CustomEvent("alphy:player-ready", { detail: { ready: false } }));
    // Remove the old <iframe>/<video> from the DOM: stops its audio instantly and
    // guarantees a new resolve never leaves stale content on screen — even when the
    // new one errors before mounting (the "плеер залочен на старом контенте" bug).
    el.playerHost.replaceChildren();
    if (state.playerPlaceholder) el.playerHost.innerHTML = state.playerPlaceholder;
    el.serialPanel.replaceChildren();
    el.serialPanel.classList.add("hidden");
    el.trackPanel.replaceChildren();
    el.trackPanel.classList.add("hidden");
  }

  function showPlayerLoading() {
    el.playerHost.innerHTML = '<div class="placeholder"><div class="spinner"></div><span>Загрузка плеера…</span></div>';
  }

  function renderTracks() {
    const player = state.player;
    if (!player) return;
    el.serialPanel.replaceChildren();
    el.serialPanel.classList.add("hidden");
    el.trackPanel.replaceChildren();
    el.trackPanel.classList.remove("hidden");
    const variants = player.getVariantTracks ? player.getVariantTracks() : [];
    // Hide text tracks superseded by a shifted copy (Shaka 4.11 can't remove them).
    const texts = (player.getTextTracks ? player.getTextTracks() : [])
      .filter((track) => !state.staleTextTrackIds.includes(track.id));

    if (state.opravar) {
      renderOpravarControls(state.opravar);
    } else {
      if (state.serial?.provider === "zenith") renderSerialControls(state.serial, switchZenithSelection);
      else if (state.serial?.provider === "liftw") renderSerialControls(state.serial, switchLiftwSelection);
      else if (state.serial?.provider === "ort") renderSerialControls(state.serial, switchOrtSelection);
      // Group on the label as well as the language: LiftW's HLS master gives all
      // three Russian dubs LANGUAGE="ru" and only tells them apart by NAME
      // (rus0/rus1/rus2), which Shaka surfaces as `label`. Keying on language
      // alone collapsed five dubs into three buttons under the wrong names.
      // Providers that ship no labels group exactly as before.
      const audioChoices = shakaAudioChoices(variants);
      addTrackGroup("Озвучка", audioChoices, (choice) => {
        const { track, name } = choice;
        const btn = document.createElement("button");
        btn.textContent = name;
        if (track.active) btn.className = "active";
        btn.addEventListener("click", () => {
          selectShakaAudio(player, track);
          persistAudioPreference(audioPreferenceForChoice(choice));
          setTimeout(renderTracks, 250);
        });
        return btn;
      });
    }

    const activeAudio = variants.find((track) => track.active)?.language || "";
    const qualityChoices = groupBy(
      variants.filter((track) => !activeAudio || track.language === activeAudio),
      (track) => `${track.height || 0}|${Math.round((track.bandwidth || 0) / 1000)}`
    ).sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bandwidth || 0) - (a.bandwidth || 0));
    const abrEnabled = shakaAbrEnabled(player);
    addTrackGroup("Качество", [{ auto: true }, ...qualityChoices], (track) => {
      const btn = document.createElement("button");
      if (track.auto) {
        const active = variants.find((item) => item.active);
        const label = qualityLabel(active);
        btn.textContent = label ? `Авто (${label})` : "Авто";
        if (abrEnabled) btn.className = "active";
        btn.addEventListener("click", () => {
          player.configure({ abr: { enabled: true } });
          setTimeout(renderTracks, 250);
        });
        return btn;
      }
      btn.textContent = `${qualityLabel(track) || "auto"} ${bitrateLabel(track)}`.trim();
      if (!abrEnabled && track.active) btn.className = "active";
      btn.addEventListener("click", () => {
        player.configure({ abr: { enabled: false } });
        player.selectVariantTrack(track, true);
        setTimeout(renderTracks, 250);
      });
      return btn;
    });

    // Subtitle-sync control: a ⚙ button that reveals two nudge buttons. Only
    // shown once we have fetched subs whose raw text we can re-shift.
    const offsetItems = state.loadedSubs.length
      ? [{ settings: true }, ...(state.subtitleOffsetOpen ? [{ offset: -0.5 }, { offsetLabel: true }, { offset: 0.5 }] : [])]
      : [];
    const subtitleItems = texts.length
      ? [{ off: true }, ...texts, ...offsetItems]
      : [
          { request: true },
          ...(state.subtitleRequest.error ? [{ note: state.subtitleRequest.error }] : []),
        ];
    addTrackGroup("Субтитры", subtitleItems, (track) => {
      const btn = document.createElement("button");
      if (track.note) {
        const span = document.createElement("span");
        span.className = "muted subtitle-note";
        span.textContent = track.note;
        return span;
      }
      if (track.request) {
        btn.textContent = state.subtitleRequest.loading
          ? "ищу…"
          : state.subtitleRequest.error
            ? "повторить"
            : "запросить";
        btn.disabled = !!state.subtitleRequest.loading;
        if (state.subtitleRequest.error) btn.title = state.subtitleRequest.error;
        else if (state.subtitleRequest.message) btn.title = state.subtitleRequest.message;
        btn.addEventListener("click", () => requestSubtitles());
        return btn;
      }
      if (track.off) {
        btn.textContent = "Выкл";
        if (!player.isTextTrackVisible || !player.isTextTrackVisible()) btn.className = "active";
        btn.addEventListener("click", () => {
          player.setTextTrackVisibility(false);
          persistSubtitlePreference({
            ...(state.subtitlePreference || {}),
            enabled: false,
            offset: state.subtitleOffset,
          });
          setTimeout(renderTracks, 50);
        });
        return btn;
      }
      if (track.settings) {
        btn.textContent = "⚙ синхр.";
        btn.title = "Сдвиг субтитров, если они не совпадают с видео";
        if (state.subtitleOffsetOpen) btn.className = "active";
        btn.addEventListener("click", () => {
          state.subtitleOffsetOpen = !state.subtitleOffsetOpen;
          renderTracks();
        });
        return btn;
      }
      if (track.offsetLabel) {
        const span = document.createElement("span");
        span.className = "muted subtitle-note";
        const o = state.subtitleOffset;
        span.textContent = `${o > 0 ? "+" : ""}${o.toFixed(1)}с`;
        return span;
      }
      if (typeof track.offset === "number") {
        btn.textContent = track.offset < 0 ? "◀ −0,5с" : "+0,5с ▶";
        btn.title = track.offset < 0 ? "Субтитры раньше" : "Субтитры позже";
        btn.disabled = !!state.subtitleOffsetBusy;
        btn.addEventListener("click", () => applySubtitleOffset(track.offset));
        return btn;
      }
      btn.textContent = track.label || track.language || "subs";
      if (track.active && player.isTextTrackVisible && player.isTextTrackVisible()) btn.className = "active";
      btn.addEventListener("click", () => {
        player.selectTextTrack(track);
        player.setTextTrackVisibility(true);
        persistSubtitlePreference(subtitlePreferenceForTrack(track, {
          requested: loadedSubtitleTrack(track),
          offset: state.subtitleOffset,
        }));
        setTimeout(renderTracks, 250);
      });
      return btn;
    });

    addTrackGroup("Скорость", [0.5, 1, 1.25, 1.5, 1.75, 2].map((s) => ({ speed: s })), (item) => {
      const btn = document.createElement("button");
      btn.textContent = `${item.speed}×`;
      if (item.speed === state.playbackRate) btn.className = "active";
      btn.addEventListener("click", () => {
        state.playbackRate = item.speed;
        try { localStorage.setItem("alphy.playbackRate", String(item.speed)); } catch { /* ignore */ }
        if (state.videoEl) state.videoEl.playbackRate = item.speed;
        setTimeout(renderTracks, 50);
      });
      return btn;
    });
  }

  async function requestSubtitles(options = {}) {
    const player = state.player;
    const token = resolveToken;
    if (!player || state.subtitleRequest.loading) return;
    const retry = !!state.subtitleRequest.error;
    const preference = cleanSubtitlePreference(options.preference) ||
      currentSubtitlePreference(player) ||
      cleanSubtitlePreference({ enabled: true, requested: true, language: WYZIE_LANGUAGES[0] });
    const requestedPreference = cleanSubtitlePreference({
      ...preference,
      enabled: true,
      requested: true,
      offset: preference?.offset ?? state.subtitleOffset,
    });
    // Remember intent before the network request. If the viewer immediately
    // advances again, the next episode still knows to continue fetching subs.
    persistSubtitlePreference(requestedPreference);
    state.subtitleRequest = { loading: true, error: "", message: "Запрашиваю субтитры…" };
    renderTracks();

    try {
      const context = await resolveSubtitleSearchContext(token);
      if (isStale(token) || player !== state.player) return;
      if (!context?.id) throw new Error("Не найден IMDb/TMDB ID для поиска субтитров");

      let added = [];
      // Primary: OpenSubtitles v3, proxied through the resolver. Needs an IMDb id
      // and is RU-reachable — the Cloudflare-fronted subtitle hosts are not, but
      // the Deno resolver fetches them server-side and returns CORS-open text.
      if (context.idKind === "imdb" && state.resolverBaseUrl) {
        try {
          added = await addOpenSubtitlesToPlayer(player, context, token);
        } catch (error) {
          if (isStale(token) || player !== state.player) return;
          log("opensubs-warn", error.message);
        }
      }

      // Fallback: Wyzie (also accepts a TMDB id), only if the primary added nothing.
      if (!added.length) {
        if (isStale(token) || player !== state.player) return;
        const forceRefresh = retry;
        const candidates = await fetchWyzieSubtitleCandidates(context, token, { forceRefresh });
        if (isStale(token) || player !== state.player) return;
        if (candidates.length) {
          added = await addWyzieSubtitlesToPlayer(player, candidates, token, { forceRefresh });
        }
      }

      if (isStale(token) || player !== state.player) return;
      if (!added.length) throw new Error("Субтитры не нашлись или не скачались в браузере");

      const texts = player.getTextTracks ? player.getTextTracks() : [];
      const addedTracks = texts.filter((track) =>
        added.some((item) => item.label === track.label && item.language === track.language));
      const latestPreference = cleanSubtitlePreference(state.subtitlePreference);
      const picked = latestPreference?.enabled && latestPreference.requested
        ? chooseSubtitleTrack(addedTracks, latestPreference) || addedTracks[0]
        : null;
      if (picked) {
        player.selectTextTrack(picked);
        player.setTextTrackVisibility(true);
        state.subtitlePreference = cleanSubtitlePreference({
          ...latestPreference,
          language: mediaLanguageFamily(picked.language, picked.label) || latestPreference.language,
        });
        persistPlaybackPreferences({ subtitlePreference: state.subtitlePreference });
      } else if (latestPreference?.enabled === false) {
        player.setTextTrackVisibility(false);
      }
      state.subtitleRequest = { loading: false, error: "", message: `Добавлено: ${added.map((item) => item.label).join(", ")}` };
      setTimeout(renderTracks, 100);
    } catch (error) {
      if (isStale(token) || player !== state.player) return;
      const message = subtitleErrorMessage(error);
      state.subtitleRequest = { loading: false, error: message, message: "" };
      log("subtitles-error", message);
      renderTracks();
    }
  }

  // --- Subtitle result cache, blob tracks, and offset/sync -----------------

  const subsMemoryCache = new Map();
  const SUBS_CACHE_NS = "subsv3";
  const SUBS_CACHE_MAX = 24;

  function subsCacheGet(key) {
    if (subsMemoryCache.has(key)) return subsMemoryCache.get(key);
    const stored = cacheGet(SUBS_CACHE_NS, key);
    if (Array.isArray(stored) && stored.length) {
      subsMemoryCache.set(key, stored);
      return stored;
    }
    return null;
  }

  function subsCacheSet(key, results) {
    subsMemoryCache.set(key, results);
    try {
      pruneSubsCache(SUBS_CACHE_MAX - 1);
      cacheSet(SUBS_CACHE_NS, key, results, TTL.subtitles);
    } catch { /* localStorage full — the in-memory cache still covers the session */ }
  }

  // Subtitle content is large (~50-150KB/title), so cap how many titles persist in
  // localStorage and evict the oldest, so the cache can never grow unbounded.
  function pruneSubsCache(max) {
    const prefix = `${CACHE_PREFIX}${SUBS_CACHE_NS}:`;
    const entries = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(prefix)) continue;
      let exp = 0;
      try { exp = JSON.parse(localStorage.getItem(k) || "{}").exp || 0; } catch { /* treat as oldest */ }
      entries.push({ k, exp });
    }
    if (entries.length <= max) return;
    entries.sort((a, b) => a.exp - b.exp);
    for (const entry of entries.slice(0, entries.length - max)) {
      try { localStorage.removeItem(entry.k); } catch { /* ignore */ }
    }
  }

  // Add a fetched subtitle to Shaka as a blob VTT track, recording its raw text +
  // Shaka track id so the offset control can re-render it shifted later.
  async function addLoadedSubtitle(player, { content, format, language, label }) {
    const vtt = shiftVtt(subtitleTextToVtt(content, format), state.subtitleOffset);
    const blobUrl = URL.createObjectURL(new Blob([vtt], { type: "text/vtt;charset=utf-8" }));
    state.subtitleObjectUrls.push(blobUrl);
    const track = await player.addTextTrackAsync(blobUrl, language, "subtitles", "text/vtt", "", label);
    state.loadedSubs.push({ language, label, content, format, trackId: track?.id ?? null });
    return track;
  }

  // Re-render every fetched subtitle with the new global offset. Shaka 4.11 has no
  // removeTextTrack, so the previous generation is hidden from the menu instead.
  async function applySubtitleOffset(delta) {
    const player = state.player;
    if (!player || !state.loadedSubs.length || state.subtitleOffsetBusy) return;
    state.subtitleOffsetBusy = true;
    try {
      state.subtitleOffset = clampOffset(state.subtitleOffset + delta);
      const activeLang = (player.getTextTracks?.() || []).find((t) => t.active)?.language
        || state.loadedSubs[0]?.language;

      for (const sub of state.loadedSubs) {
        if (sub.trackId != null) state.staleTextTrackIds.push(sub.trackId);
      }

      const regenerated = [];
      for (const sub of state.loadedSubs) {
        const vtt = shiftVtt(subtitleTextToVtt(sub.content, sub.format), state.subtitleOffset);
        const blobUrl = URL.createObjectURL(new Blob([vtt], { type: "text/vtt;charset=utf-8" }));
        state.subtitleObjectUrls.push(blobUrl);
        const track = await player.addTextTrackAsync(blobUrl, sub.language, "subtitles", "text/vtt", "", sub.label);
        regenerated.push({ ...sub, trackId: track?.id ?? null });
      }
      state.loadedSubs = regenerated;

      const pick = regenerated.find((s) => s.language === activeLang) || regenerated[0];
      const newTrack = (player.getTextTracks?.() || []).find((t) => t.id === pick?.trackId);
      if (newTrack) {
        player.selectTextTrack(newTrack);
        player.setTextTrackVisibility(true);
      }
      if (state.subtitlePreference) {
        persistSubtitlePreference({ ...state.subtitlePreference, offset: state.subtitleOffset });
      }
    } catch (error) {
      log("subtitle-offset-warn", error.message);
    } finally {
      state.subtitleOffsetBusy = false;
      renderTracks();
    }
  }

  function clampOffset(seconds) {
    return Math.max(-60, Math.min(60, Math.round(seconds * 10) / 10));
  }

  // Shift every WEBVTT timestamp (cue start and end) by offsetSeconds, in integer
  // milliseconds so rounding can never produce an invalid ".1000" fraction.
  function shiftVtt(vtt, offsetSeconds) {
    if (!offsetSeconds) return vtt;
    const deltaMs = Math.round(offsetSeconds * 1000);
    return String(vtt).replace(/(\d{2,}):([0-5]\d):([0-5]\d)\.(\d{3})/g, (_, h, m, s, ms) => {
      let total = ((+h) * 3600 + (+m) * 60 + (+s)) * 1000 + (+ms) + deltaMs;
      if (total < 0) total = 0;
      const pad = (n, w = 2) => String(n).padStart(w, "0");
      return `${pad(Math.floor(total / 3600000))}:${pad(Math.floor((total % 3600000) / 60000))}:${pad(Math.floor((total % 60000) / 1000))}.${pad(total % 1000, 3)}`;
    });
  }

  // OpenSubtitles v3 via the resolver /subs proxy: it returns ready subtitle text
  // (CORS-open), which we convert to VTT and hand to Shaka as a blob track.
  async function addOpenSubtitlesToPlayer(player, context, token) {
    const type = context.season && context.episode ? "series" : "movie";
    const cacheKey = `${context.id}:${type}:${type === "series" ? `${context.season}:${context.episode}` : ""}:${WYZIE_LANGUAGES.join(",")}`;

    // Cache the resolver result (memory for the session + a bounded localStorage
    // copy), so re-opening an already-seen episode never hits the resolver again.
    let results = subsCacheGet(cacheKey);
    if (!results) {
      const params = new URLSearchParams({ imdb: context.id, type, lang: WYZIE_LANGUAGES.join(",") });
      if (type === "series") {
        params.set("season", String(context.season));
        params.set("episode", String(context.episode));
      }
      const data = await resolverJson(`/subs?${params}`);
      if (isStale(token) || player !== state.player) return [];
      results = Array.isArray(data?.results) ? data.results : [];
      if (results.length) subsCacheSet(cacheKey, results);
    }

    const added = [];
    const seenLabels = new Set();
    for (const item of results) {
      if (isStale(token) || player !== state.player) break;
      try {
        const label = uniqueSubtitleLabel(item.label || item.language || "Subs", seenLabels);
        seenLabels.add(label);
        await addLoadedSubtitle(player, { content: item.content, format: item.format, language: item.language || "und", label });
        added.push({ label, language: item.language || "und" });
      } catch (error) {
        log("opensubs-track-warn", { language: item.language, message: error.message });
      }
    }
    return added;
  }

  async function resolveSubtitleSearchContext(token) {
    const target = state.currentTarget || {};
    let meta = state.currentMeta || {};
    let kpId = target.kind === "kp" ? target.kpId : (meta.kpId || meta.kinopoiskId || meta.id);
    let external = subtitleExternalId(meta);

    if (!external.id && kpId) {
      const fresh = await fetchMovieMeta(kpId);
      if (isStale(token)) return null;
      if (fresh) {
        meta = mergeMetadata(meta, fresh);
        cacheMovieMetadata(kpId, meta);
        state.currentMeta = meta;
        if (state.currentTarget) {
          state.currentTarget.poster = meta.poster || state.currentTarget.poster;
          state.currentTarget.year = meta.year || state.currentTarget.year;
          state.currentTarget.isSeries = meta.isSeries ?? state.currentTarget.isSeries;
          renderMeta(meta, state.currentTarget);
        }
        external = subtitleExternalId(meta);
      }
    }

    if (!external.id && !kpId) {
      const title = meta.title || movieTitle(meta) || target.title || "";
      if (title) {
        const results = await searchPoiskkino(cleanMovieTitle(title), meta.year || target.year);
        if (isStale(token)) return null;
        const movie = chooseMovie(results, title, meta.year || target.year);
        kpId = movie?.kpId;
        if (kpId) {
          const fresh = await fetchMovieMeta(kpId);
          if (isStale(token)) return null;
          meta = mergeMetadata(meta, fresh || movie);
          cacheMovieMetadata(kpId, meta);
          state.currentMeta = meta;
          if (state.currentTarget) renderMeta(meta, state.currentTarget);
          external = subtitleExternalId(meta);
        }
      }
    }

    if (!external.id && kpId) {
      const externalId = await fetchWikidataExternalIds(kpId);
      if (isStale(token)) return null;
      if (externalId) {
        meta = mergeMetadata(meta, { kpId, externalId });
        state.currentMeta = meta;
        cacheMovieMetadata(kpId, meta);
        if (state.currentTarget) renderMeta(meta, state.currentTarget);
        external = subtitleExternalId(meta);
      }
    }

    const selection = currentSubtitleSelection(meta, target);
    return {
      id: external.id,
      idKind: external.kind,
      kpId,
      title: meta.title || movieTitle(meta) || target.title || "",
      season: selection.season,
      episode: selection.episode,
    };
  }

  function currentSubtitleSelection(meta = {}, target = {}) {
    const selection = state.serial?.selection || state.opravar?.selection || savedSerialSelection(keyFor(target));
    const season = positiveInt(selection?.season);
    const episode = positiveInt(selection?.episode);
    if (!(meta.isSeries ?? target.isSeries) || !season || !episode) return {};
    return { season, episode };
  }

  function subtitleExternalId(meta = {}) {
    const external = meta.externalId || meta.externalIds || {};
    const imdb = compact(
      external.imdb ||
      external.imdbId ||
      meta.imdbId ||
      meta.externalImdbId ||
      "",
    );
    const tmdb = compact(
      external.tmdb ||
      external.tmdbId ||
      meta.tmdbId ||
      meta.externalTmdbId ||
      "",
    );
    if (/^tt\d{5,}$/i.test(imdb)) return { id: imdb, kind: "imdb" };
    if (/^\d+$/.test(tmdb)) return { id: tmdb, kind: "tmdb" };
    return { id: "", kind: "" };
  }

  async function fetchWikidataExternalIds(kpId) {
    const id = String(kpId || "").trim();
    if (!/^\d+$/.test(id)) return null;
    const cached = cacheGet("wikidataids", id);
    if (cached && typeof cached === "object") return cached;
    const query = `
SELECT ?imdb ?tmdbMovie ?tmdbTv WHERE {
  ?item wdt:P2603 "${id}".
  OPTIONAL { ?item wdt:P345 ?imdb. }
  OPTIONAL { ?item wdt:P4947 ?tmdbMovie. }
  OPTIONAL { ?item wdt:P4983 ?tmdbTv. }
}
LIMIT 1`;
    const url = `https://query.wikidata.org/sparql?${new URLSearchParams({ query, format: "json" })}`;
    try {
      const response = await fetchWithTimeout(url, {
        headers: { Accept: "application/sparql-results+json,application/json" },
      }, 12000);
      const data = JSON.parse(await response.text());
      if (!response.ok) throw new Error(`Wikidata ${response.status}`);
      const binding = data?.results?.bindings?.[0] || {};
      const externalId = {
        imdb: compact(binding.imdb?.value || ""),
        tmdb: compact(binding.tmdbMovie?.value || binding.tmdbTv?.value || ""),
      };
      if (!/^tt\d{5,}$/i.test(externalId.imdb)) delete externalId.imdb;
      if (!/^\d+$/.test(externalId.tmdb || "")) delete externalId.tmdb;
      if (!Object.keys(externalId).length) return null;
      cacheSet("wikidataids", id, externalId, TTL.enriched);
      return externalId;
    } catch (error) {
      log("wikidata-external-id-warn", { kpId: id, message: error.message });
      return null;
    }
  }

  async function fetchWyzieSubtitleCandidates(context, token, options = {}) {
    const cacheKey = [
      context.id,
      context.season || "movie",
      context.episode || "",
      WYZIE_LANGUAGES.join(","),
    ].join(":");
    const cached = options.forceRefresh ? null : cacheGet("wyziesubs", cacheKey);
    if (Array.isArray(cached) && cached.length) return cached;

    let lastError = null;
    for (const [index, key] of WYZIE_KEYS.entries()) {
      try {
        const sources = await fetchWyzieSources(key, index);
        if (isStale(token)) return [];
        const params = new URLSearchParams({
          id: context.id,
          language: WYZIE_LANGUAGES.join(","),
          format: "srt,vtt",
          key,
        });
        if (sources.length) params.set("source", sources.join(","));
        if (context.season) params.set("season", String(context.season));
        if (context.episode) params.set("episode", String(context.episode));
        if (options.forceRefresh) params.set("refresh", "true");

        const response = await fetchWithTimeout(`${WYZIE_BASE_URL}/search?${params}`, {
          headers: { Accept: "application/json" },
          cache: "no-store",
        }, 18000);
        const body = await response.text();
        let data;
        try { data = JSON.parse(body); } catch { data = { message: body }; }
        if (!response.ok) throw new Error(data?.details || data?.message || `Wyzie ${response.status}`);
        const items = normalizeWyzieResults(data);
        if (items.length) {
          cacheSet("wyziesubs", cacheKey, items, TTL.subtitles);
          return items;
        }
      } catch (error) {
        lastError = error;
        log("wyzie-search-warn", { keyIndex: index + 1, message: error.message });
      }
    }
    if (lastError) throw lastError;
    return [];
  }

  async function fetchWyzieSources(key, index) {
    const cacheKey = String(index + 1);
    const cached = cacheGet("wyziesources", cacheKey);
    if (Array.isArray(cached)) return cached;
    try {
      const response = await fetchWithTimeout(`${WYZIE_BASE_URL}/sources?key=${encodeURIComponent(key)}`, {
        headers: { Accept: "application/json" },
      }, 10000);
      const data = JSON.parse(await response.text());
      const sources = Array.isArray(data?.available) ? data.available.map(compact).filter(Boolean) : [];
      cacheSet("wyziesources", cacheKey, sources, TTL.subtitles);
      return sources;
    } catch (error) {
      log("wyzie-sources-warn", { keyIndex: index + 1, message: error.message });
      return ["charlie", "lima"];
    }
  }

  function normalizeWyzieResults(data) {
    return (Array.isArray(data) ? data : [])
      .map((item) => ({
        language: compact(item.language || item.lang || ""),
        display: compact(item.display || item.language || ""),
        source: compact(item.source || ""),
        format: compact(item.format || "srt").toLowerCase(),
        url: compact(item.url || item.download || ""),
        release: compact(item.release || item.filename || item.name || ""),
      }))
      .filter((item) => item.url && /^https:\/\//i.test(item.url));
  }

  async function addWyzieSubtitlesToPlayer(player, candidates, token, options = {}) {
    const added = [];
    const seenLabels = new Set();
    const ordered = orderWyzieCandidates(candidates);
    const perLanguageAdded = new Set();
    let attempts = 0;

    for (const item of ordered) {
      if (isStale(token) || player !== state.player) return added;
      const language = item.language || "und";
      if (perLanguageAdded.has(language)) continue;
      if (attempts >= 14 || added.length >= 3) break;
      attempts += 1;

      try {
        const downloadUrl = wyzieDownloadUrl(item, { cacheBust: options.forceRefresh });
        const raw = await fetchSubtitleText(downloadUrl);
        const label = uniqueSubtitleLabel(wyzieSubtitleLabel(item), seenLabels);
        seenLabels.add(label);
        await addLoadedSubtitle(player, { content: raw, format: item.format, language, label });
        added.push({ label, language });
        perLanguageAdded.add(language);
      } catch (error) {
        log("wyzie-download-warn", {
          language: item.language,
          source: item.source,
          message: error.message,
        });
      }
    }

    return added;
  }

  function orderWyzieCandidates(candidates) {
    const rankLanguage = (lang) => {
      const index = WYZIE_LANGUAGES.indexOf(String(lang || "").toLowerCase());
      return index === -1 ? 99 : index;
    };
    const rankSource = (source) => String(source || "") === "lima" ? 0 : 1;
    return [...candidates].sort((a, b) =>
      rankLanguage(a.language) - rankLanguage(b.language) ||
      rankSource(a.source) - rankSource(b.source) ||
      (a.release || "").length - (b.release || "").length
    );
  }

  function wyzieDownloadUrl(item, options = {}) {
    const url = item.url || "";
    const key = options.key || WYZIE_KEYS[0];
    // The Wyzie /c/ content proxy (and any sub.wyzie.io endpoint) needs the API
    // key as a `key` query param, exactly like /search and /sources. Without it
    // the proxy answers with an empty body, so the download silently fails and
    // the subtitle never reaches the player. This is the whole reason Wyzie subs
    // would not embed. The proxy returns CORS `access-control-allow-origin: *`,
    // so once the key is attached the fetch is fully client-side.
    const finalizeUrl = (value) => {
      try {
        const parsed = new URL(value);
        if (key && /(^|\.)wyzie\.io$/i.test(parsed.hostname) && !parsed.searchParams.has("key")) {
          parsed.searchParams.set("key", key);
        }
        if (options.cacheBust) parsed.searchParams.set("_", String(Date.now()));
        return parsed.href;
      } catch {
        return value;
      }
    };
    try {
      const parsed = new URL(url);
      if (/dl\.opensubtitles\.org$/i.test(parsed.hostname)) {
        const match = parsed.pathname.match(/\/vrf-([^/]+)\/file\/(\d+)/i);
        if (match) {
          const format = item.format === "vtt" ? "vtt" : "srt";
          return finalizeUrl(`${WYZIE_BASE_URL}/c/${encodeURIComponent(match[1])}/id/${encodeURIComponent(match[2])}?format=${format}&encoding=UTF-8`);
        }
      }
    } catch {
      // Use the original URL below; fetch will report the real failure.
    }
    return finalizeUrl(url);
  }

  async function fetchSubtitleText(url) {
    const response = await fetchWithTimeout(url, {
      headers: { Accept: "text/vtt,text/plain,*/*" },
      cache: "no-store",
    }, 20000);
    const text = await response.text();
    if (!response.ok) throw new Error(`download ${response.status}`);
    const clean = text.replace(/^\uFEFF/, "").trim();
    if (!clean) throw new Error("empty subtitle file");
    if (/^<!doctype html|<html[\s>]/i.test(clean)) throw new Error("download returned html");
    if (!/-->/m.test(clean) && !/^WEBVTT/i.test(clean)) throw new Error("not a subtitle file");
    return text;
  }

  function subtitleTextToVtt(text, format = "") {
    const clean = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
    if (/^WEBVTT/i.test(clean)) return `${clean}\n`;
    if (/^\[Script Info\]/i.test(clean) || format === "ass") throw new Error("ASS subtitles are not supported in browser Shaka");
    const body = clean
      .replace(/(\d{1,2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2")
      .replace(/\{\\an\d+\}/g, "")
      .replace(/\n{3,}/g, "\n\n");
    if (!/-->/m.test(body)) throw new Error("invalid subtitle timing");
    return `WEBVTT\n\n${body}\n`;
  }

  function wyzieSubtitleLabel(item) {
    const lang = String(item.language || "").toLowerCase();
    const display =
      lang === "ru" ? "Русские" :
      lang === "en" ? "English" :
      item.display || lang || "Subs";
    const source = item.source ? ` · ${item.source}` : "";
    return `${display}${source}`;
  }

  function uniqueSubtitleLabel(label, seen) {
    let value = label || "Subs";
    let index = 2;
    while (seen.has(value)) {
      value = `${label} ${index}`;
      index += 1;
    }
    return value;
  }

  function subtitleErrorMessage(error) {
    const message = String(error?.message || error || "");
    if (/IMDb\/TMDB/i.test(message)) return "Не найден IMDb/TMDB ID для Wyzie";
    if (/No subtitles found|не наш/i.test(message)) return "Wyzie не нашёл субтитры";
    if (/empty subtitle|download|cors|failed to fetch/i.test(message)) return "Субтитры найдены, но файл не скачался в браузере";
    return message || "Не удалось запросить субтитры";
  }

  async function fetchWithTimeout(url, init = {}, timeoutMs = 15000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  function renderOpravarControls(context) {
    const seasons = context.playlist || [];
    const current = chooseOpravarSelection(seasons, context.selection);
    const season = seasons.find((item) => item.season === current?.season);
    const episode = season?.episodes.find((item) => item.episode === current?.episode);

    addTrackGroup("", seasons, (item) => {
      const btn = document.createElement("button");
      btn.textContent = `Сезон ${item.season}`;
      if (item.season === current?.season) btn.className = "active";
      btn.addEventListener("click", () => {
        const preferredEpisode =
          item.episodes.find((value) => value.episode === current?.episode) ||
          item.episodes.find((value) => value.episode > 0) ||
          item.episodes[0];
        switchOpravarSelection({
          season: item.season,
          episode: preferredEpisode?.episode,
          voiceId: current?.voiceId,
          voiceName: current?.voiceName,
        });
      });
      return btn;
    }, { panel: el.serialPanel, hideLabel: true, className: "serial-seasons" });

    addTrackGroup("", season?.episodes || [], (item) => {
      const btn = document.createElement("button");
      btn.textContent = item.episode > 0 ? String(item.episode) : `S${Math.abs(item.episode)}`;
      if (item.episode === current?.episode) btn.className = "active";
      btn.addEventListener("click", () => {
        switchOpravarSelection({
          season: current?.season,
          episode: item.episode,
          voiceId: current?.voiceId,
          voiceName: current?.voiceName,
        });
      });
      return btn;
    }, { panel: el.serialPanel, hideLabel: true, className: "serial-episodes" });

    addTrackGroup("Озвучка", episode?.voices || [], (item) => {
      const btn = document.createElement("button");
      btn.textContent = item.name || `Voice ${item.voiceId}`;
      if (item.voiceId === current?.voiceId) btn.className = "active";
      btn.addEventListener("click", () => {
        switchOpravarSelection({
          season: current?.season,
          episode: current?.episode,
          voiceId: item.voiceId,
          voiceName: item.name,
        });
      });
      return btn;
    });
  }

  // Shared by every provider whose playlist is a preloaded seasons[].episodes[]
  // (Zenith, LiftW); `onSelect` is the provider's episode switcher.
  function renderSerialControls(context, onSelect) {
    const seasons = context.seasons || [];
    const current = chooseSerialSelection(seasons, context.selection);
    const season = seasons.find((item) => item.season === current?.season);

    addTrackGroup("", seasons, (item) => {
      const btn = document.createElement("button");
      btn.textContent = `Сезон ${item.season}`;
      btn.disabled = !!context.switching;
      if (item.season === current?.season) btn.className = "active";
      btn.addEventListener("click", () => {
        const sameEpisode = item.episodes.find((value) => value.episode === current?.episode);
        const episode = sameEpisode || item.episodes[0];
        onSelect({ season: item.season, episode: episode?.episode });
      });
      return btn;
    }, { panel: el.serialPanel, hideLabel: true, className: "serial-seasons" });

    addTrackGroup("", season?.episodes || [], (item) => {
      const btn = document.createElement("button");
      btn.textContent = String(item.episode);
      btn.disabled = !!context.switching;
      if (item.title) btn.title = item.title;
      if (item.episode === current?.episode) btn.className = "active";
      btn.addEventListener("click", () => {
        onSelect({ season: current?.season, episode: item.episode });
      });
      return btn;
    }, { panel: el.serialPanel, hideLabel: true, className: "serial-episodes" });
  }

  function addTrackGroup(title, items, renderButton, options = {}) {
    const panel = options.panel || el.trackPanel;
    const group = document.createElement("div");
    group.className = `track-group${options.className ? ` ${options.className}` : ""}`;
    const label = document.createElement("strong");
    label.textContent = title;
    const buttons = document.createElement("div");
    buttons.className = "track-buttons";
    if (!items.length) {
      const span = document.createElement("span");
      span.className = "muted";
      span.textContent = "—";
      buttons.appendChild(span);
    } else {
      items.forEach((item, index) => buttons.appendChild(renderButton(item, index)));
    }
    if (!options.hideLabel) group.appendChild(label);
    group.appendChild(buttons);
    panel.appendChild(group);
    panel.classList.remove("hidden");
  }

  // =====================================================================
  // Engine: third-party fetch, newdeaf parsing, Zenith/Ortified parsing
  // (ported verbatim from the proven MVP — do not "simplify".)
  // =====================================================================
  function fetchCachedEmbedText(url, options = {}, ttlMs = 2 * 60e3) {
    const cached = embedTextCache.get(url);
    if (cached?.text && cached.expiresAt > Date.now()) return Promise.resolve(cached.text);
    if (embedTextInflight.has(url)) return embedTextInflight.get(url);
    const pending = fetchThirdPartyText(url, options)
      .then((text) => {
        embedTextCache.set(url, { text, expiresAt: Date.now() + ttlMs });
        return text;
      })
      .finally(() => embedTextInflight.delete(url));
    embedTextInflight.set(url, pending);
    return pending;
  }

  function progressHook() {
    // We build the Ortified cleanroom srcdoc ourselves, so a script we inject runs
    // in the SAME document as the player's <video> and can read its position even
    // though the parent page can't reach a cross-origin iframe. We can't stop the
    // player resetting on reload, but we can report where the viewer stopped so the
    // homepage shows progress. Posts {alphyOrtProgress, position, duration} out.
    //
    // The iframe <video> has no hardware overlay, so it micro-stutters whenever
    // this shared main thread is busy. The canvas snapshot that used to ride
    // along here was the most expensive thing we ran and is gone entirely; what
    // is left is a position report, sent less often on weak devices.
    const tv = TIZEN_VIDEO_MODE;
    const weak = weakVideoDevice();
    const sendMs = tv ? 30000 : weak ? 10000 : 4000;
    const discovery = tv
      ? `
  const videos = new Set();
  const hook = (v) => {
    if (hooked.has(v)) return; hooked.add(v); videos.add(v);
    v.addEventListener('pause', () => { lastSent = 0; send(v); });
  };
  const discover = () => { try { document.querySelectorAll('video').forEach(hook); } catch (e) {} };
  discover();
  try { new MutationObserver(discover).observe(document.documentElement, { childList: true, subtree: true }); } catch (e) {}
  setInterval(() => videos.forEach((v) => {
    if (v.isConnected === false) videos.delete(v); else send(v);
  }), SEND_MS);`
      : `
  const hook = (v) => {
    if (hooked.has(v)) return; hooked.add(v);
    v.addEventListener('timeupdate', () => send(v));
    v.addEventListener('pause', () => { lastSent = 0; send(v); });
  };
  setInterval(() => { try { document.querySelectorAll('video').forEach(hook); } catch (e) {} }, 1500);`;
    return `<script data-cleanroom="progress-hook">
(() => {
  const SEND_MS = ${sendMs};
  const hooked = new WeakSet();
  let lastSent = 0;
  const send = (v) => {
    const now = Date.now();
    if (now - lastSent < SEND_MS) return;
    if (!v.duration || !isFinite(v.duration) || v.duration <= 0) return;
    lastSent = now;
    try { parent.postMessage({ alphyOrtProgress: true, position: v.currentTime, duration: v.duration }, '*'); } catch (e) {}
  };
${discovery}
})();
<\/script>`;
  }

  async function fetchThirdPartyText(url, options = {}) {
    const preferSandbox = !!options.preferSandbox;
    const timeoutMs = options.timeoutMs || 30000;
    const sandboxTimeoutMs = options.sandboxTimeoutMs || timeoutMs;
    if (options.directOnly) return directFetchText(url, timeoutMs);
    if (preferSandbox) {
      try {
        return await sandboxFetchText(url, options.label, sandboxTimeoutMs, options.signal);
      } catch (error) {
        if (options.directFallback === false) throw error;
        log("fetch-warn", "sandbox fetch failed; trying direct CORS", { url, message: error.message });
      }
    }
    try {
      return await directFetchText(url, timeoutMs);
    } catch (error) {
      log("fetch-warn", "direct CORS fetch failed; trying XHR", { url, message: error.message });
    }
    try {
      return await xhrFetchText(url, timeoutMs);
    } catch (error) {
      if (!preferSandbox) {
        log("fetch-warn", "XHR failed; trying sandbox", { url, message: error.message });
        return sandboxFetchText(url, options.label, sandboxTimeoutMs);
      }
      throw error;
    }
  }

  function directFetchText(url, timeoutMs) {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    let timer = null;
    const operation = (async () => {
      const response = await fetch(url, {
        cache: "no-store",
        credentials: "omit",
        mode: "cors",
        referrerPolicy: "no-referrer",
        ...(controller ? { signal: controller.signal } : {}),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`Fetch ${response.status}`);
      return text;
    })();
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller?.abort();
        reject(new Error(`Direct fetch timeout for ${url}`));
      }, timeoutMs);
    });
    return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
  }

  function xhrFetchText(url, timeoutMs) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", url, true);
      xhr.withCredentials = false;
      xhr.timeout = timeoutMs;
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.responseText);
        else reject(new Error(`XHR ${xhr.status || "failed"}`));
      };
      xhr.onerror = () => reject(new Error(`XHR network error for ${url}`));
      xhr.ontimeout = () => reject(new Error(`XHR timeout for ${url}`));
      xhr.onabort = () => reject(new Error(`XHR aborted for ${url}`));
      try {
        xhr.send();
      } catch (error) {
        reject(error);
      }
    });
  }

  function sandboxFetchText(url, label, timeoutMs, signal) {
    if (!isOpaqueFetchUrl(url)) return Promise.reject(new Error(`Sandbox fetch blocked for ${url}`));
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return new Promise((resolve, reject) => {
      const iframe = document.createElement("iframe");
      iframe.sandbox = "allow-scripts";
      iframe.referrerPolicy = "no-referrer";
      iframe.style.cssText = "position:absolute;width:1px;height:1px;left:-9999px;top:-9999px;border:0";
      let settled = false;
      const cancelled = () => cleanup(new Error("Sandbox fetch cancelled"));
      const timer = setTimeout(() => cleanup(new Error(`Sandbox fetch timeout for ${url}`)), timeoutMs || 30000);
      const cleanup = (error, value) => {
        if (settled) return;
        settled = true; signal?.removeEventListener("abort", cancelled);
        clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        iframe.remove();
        if (error) reject(error);
        else resolve(value);
      };
      const onMessage = (event) => {
        if (event.source !== iframe.contentWindow || event.origin !== "null") return;
        const data = event.data || {};
        if (!data.alphyFetch || data.id !== id) return;
        if (data.requestOrigin !== "null") { cleanup(new Error(`Sandbox origin leak for ${url}`)); return; }
        if (data.documentReferrer) { cleanup(new Error(`Sandbox referrer leak for ${url}`)); return; }
        if (!data.ok) { cleanup(new Error(data.error || `Sandbox fetch failed for ${url}`)); return; }
        cleanup(null, data.text);
      };
      signal?.addEventListener("abort", cancelled, { once: true });
      if (signal?.aborted) { cancelled(); return; }
      window.addEventListener("message", onMessage);
      iframe.addEventListener("load", () => iframe.contentWindow.postMessage({ alphyFetch: true, id, url }, "*"), { once: true });
      iframe.srcdoc = `<!doctype html><meta charset="utf-8"><script>
addEventListener('message', async (event) => {
  const data = event.data || {};
  if (event.source !== parent || !data.alphyFetch) return;
  try {
    const target = new URL(data.url);
    const host = target.hostname.toLowerCase();
    const allowed = target.protocol === 'https:' && (
      host === 'plapi.cdnvideohub.com' ||
      ((host === 'embed.liftw.ws' || host === 'lift3.ws') && /^\\/embed\\/movie\\/\\d+$/.test(target.pathname)) ||
      host === 'api.ortified.ws' ||
      host === 'api.zenithjs.ws' ||
      host === 'newdeaf.co' || host.endsWith('.newdeaf.co') ||
      /^static\\.voidboost\\.[a-z]{2,6}$/.test(host)
    );
    if (!allowed) throw new Error('Blocked sandbox URL');
    const response = await fetch(data.url, { cache: 'no-store', credentials: 'omit', mode: 'cors', referrerPolicy: 'no-referrer' });
    const text = await response.text();
    if (!response.ok) throw new Error('Fetch ' + response.status);
    parent.postMessage({ alphyFetch: true, id: data.id, ok: true, requestOrigin: location.origin, documentReferrer: document.referrer, status: response.status, contentType: response.headers.get('content-type') || '', text }, '*');
  } catch (error) {
    parent.postMessage({ alphyFetch: true, id: data.id, ok: false, requestOrigin: location.origin, documentReferrer: document.referrer, error: String(error && error.message || error) }, '*');
  }
});
<\/script>`;
      document.body.appendChild(iframe);
    });
  }

  function isOpaqueFetchUrl(value) {
    try {
      const url = new URL(value);
      const host = url.hostname.toLowerCase();
      return url.protocol === "https:" && (
        host === "plapi.cdnvideohub.com" ||
        ((host === "embed.liftw.ws" || host === "lift3.ws") && /^\/embed\/movie\/\d+$/.test(url.pathname)) ||
        host === "api.ortified.ws" ||
        host === "api.zenithjs.ws" ||
        host === "newdeaf.co" || host.endsWith(".newdeaf.co") ||
        // HDRezka's subtitle CDN. Matched by pattern rather than one literal
        // host because Voidboost rotates the TLD (streams have already moved
        // .cc -> .one); pinning `static.voidboost.com` would fail closed and
        // silently drop subtitles the next time it moves. Still only the one
        // `static.` subdomain, never the whole domain.
        /^static\.voidboost\.[a-z]{2,6}$/.test(host)
      );
    } catch {
      return false;
    }
  }

  function warmNewdeafConnections() {
    for (const origin of unique([dailyMirrorCandidates()[0], "https://newdeaf.co"])) {
      if (!origin || newdeafWarmOrigins.has(origin)) continue;
      newdeafWarmOrigins.add(origin);
      const link = document.createElement("link");
      link.rel = "preconnect";
      link.href = origin;
      link.crossOrigin = "anonymous";
      document.head.appendChild(link);
    }
  }

  function warmSoapConnections(masterUrl = "") {
    const origins = ["https://soap4youand.me", SOAP_CDN_ORIGIN];
    try {
      if (masterUrl) origins.push(new URL(masterUrl).origin);
    } catch { /* ignore malformed catalog entries */ }
    for (const origin of unique(origins)) {
      if (!origin || soapWarmOrigins.has(origin)) continue;
      soapWarmOrigins.add(origin);
      const link = document.createElement("link");
      link.rel = "preconnect";
      link.href = origin;
      link.crossOrigin = "anonymous";
      document.head.appendChild(link);
    }
  }

  function warmCollapsConnections(mediaUrl = "") {
    const origins = [new URL(COLLAPS_BASE_URL).origin];
    try {
      if (mediaUrl) origins.push(new URL(mediaUrl).origin);
    } catch {
      /* ignore signed URL parse failures */
    }
    for (const origin of unique(origins)) {
      if (!origin || collapsWarmOrigins.has(origin)) continue;
      collapsWarmOrigins.add(origin);
      const link = document.createElement("link");
      link.rel = "preconnect";
      link.href = origin;
      link.crossOrigin = "anonymous";
      document.head.appendChild(link);
    }
  }

  function warmRezkaConnections(resolved) {
    const urls = [
      ...(resolved?.streams || []).map((item) => item?.url),
      ...(resolved?.subtitles || []).map((item) => item?.url),
    ];
    for (const value of urls) {
      let origin = "";
      try { origin = new URL(value).origin; } catch { /* ignore malformed signed URLs */ }
      if (!origin || rezkaWarmOrigins.has(origin)) continue;
      rezkaWarmOrigins.add(origin);
      const link = document.createElement("link");
      link.rel = "preconnect";
      link.href = origin;
      link.crossOrigin = "anonymous";
      document.head.appendChild(link);
    }
  }

  function scheduleIdle(callback, timeout = 2500) {
    if (typeof requestIdleCallback === "function") {
      return requestIdleCallback(callback, { timeout });
    }
    return setTimeout(callback, Math.min(timeout, 1000));
  }

  function prefetchTopNewdeafPage(candidates) {
    const pageUrl = candidates?.[0]?.url;
    if (!pageUrl || newdeafPagePrefetches.has(pageUrl)) return;
    const warmPlayer = (parsed) => {
      const embedUrl = parsed?.ortified?.[0];
      if (embedUrl) return fetchCachedEmbedText(embedUrl, { preferSandbox: true, label: "ortified-prefetch" });
      return null;
    };
    const cached = cacheGet("ndpage", pageUrl);
    if (cached) {
      scheduleIdle(() => warmPlayer(cached)?.catch((error) => log("ortified-prefetch-warn", error.message)));
      return;
    }
    newdeafPagePrefetches.add(pageUrl);
    scheduleIdle(() => {
      resolveNewdeafPage(pageUrl)
        .then((parsed) => warmPlayer(parsed))
        .catch((error) => {
          newdeafPagePrefetches.delete(pageUrl);
          log("newdeaf-prefetch-warn", error.message);
        });
    });
  }

  function prefetchTopSoapManifest(movies) {
    const movie = (movies || []).find((m) => m?.m);
    const url = movie?.m;
    if (!url || soapManifestPrefetches.has(url)) return;
    soapManifestPrefetches.add(url);
    warmSoapConnections(url);
    scheduleIdle(() => {
      fetch(url, {
        cache: "force-cache",
        credentials: "omit",
        mode: "cors",
        referrerPolicy: "no-referrer",
      })
        .then(async (response) => {
          const text = await response.text();
          if (!response.ok || !/#EXTM3U/i.test(text)) throw new Error(`manifest ${response.status}`);
        })
        .catch((error) => {
          soapManifestPrefetches.delete(url);
          log("soap-prefetch-warn", error.message);
        });
    }, 1800);
  }

  // Intent-time Zenith warm. Cheap by construction: a cached parse short-circuits
  // before any request, the resolver answers warm hits from its own edge cache,
  // and the hover token bucket caps how many of these a browsing burst can start.
  async function warmZenithParsed(embedUrl, details = {}) {
    if (!zenithIdOf(embedUrl)) return;
    await resolveZenithParsed(embedUrl, { wantSeasons: !!details?.isSeries });
  }

  function recommendationCacheKey(item) {
    const kpId = String(item?.kpId || item?.target?.kpId || "");
    if (/^\d+$/.test(kpId)) return `kp:${kpId}`;
    return `${normalizeTitle(item?.title || "")}|${item?.year || ""}|${item?.isSeries ? "s" : "f"}`;
  }

  function cachedRecommendationTarget(value) {
    if (value?.miss) return null;
    const embedUrl = canonicalOrtEmbedUrl(value?.target?.embedUrl || "");
    return embedUrl ? { kind: "ort", embedUrl } : null;
  }

  // Recommendations originate as kp: items, but Newdeaf has no Kinopoisk id.
  // Resolve the exact Russian title client-side, verify that the matched page
  // actually exposes Ortified, and remember the resulting direct embed. Fuzzy
  // matches are intentionally forbidden here: falling back to kp is always safer
  // than opening a different film with one shared word in its title.
  async function resolveRecommendationTarget(item) {
    if (!item?.target?.kind || item.target.kind !== "kp") return item?.target || null;
    const cacheKey = recommendationCacheKey(item);
    const cached = cacheGet(ND_RECOMMEND_CACHE_NS, cacheKey);
    if (cached) return cachedRecommendationTarget(cached);
    const inflight = newdeafRecommendationInflight.get(cacheKey);
    if (inflight) return inflight;

    const pending = (async () => {
      const query = cleanMovieTitle(item.title || "");
      if (!query || !/[а-яё]/i.test(query)) return null;
      const results = await searchNewdeaf(query);
      const hit = pickExactNewdeafResult(results, item);
      if (!hit) {
        // First-paint recommendations can arrive before their batch metadata, so
        // an absent year may be temporary. Do not pin an ambiguous title-only miss
        // under the kpId before the enriched row gets a chance to retry it.
        if (item.year) cacheSet(ND_RECOMMEND_CACHE_NS, cacheKey, { miss: true }, TTL.ndrecommendMiss);
        return null;
      }
      const parsed = await resolveNewdeafPage(hit.url);
      const embedUrl = canonicalOrtEmbedUrl(parsed?.ortified?.[0] || "");
      if (!embedUrl) {
        cacheSet(ND_RECOMMEND_CACHE_NS, cacheKey, { miss: true }, TTL.ndrecommendMiss);
        return null;
      }
      const kpId = String(item.kpId || item.target.kpId || "");
      const meta = {
        ...item,
        title: item.title || parsed.title || hit.title || "",
        year: item.year || parsed.year || extractYear(`${hit.title || ""} ${hit.url || ""}`),
        poster: item.poster || parsed.poster || hit.poster || "",
        kpId: /^\d+$/.test(kpId) ? kpId : "",
        target: { kind: "ort", embedUrl },
      };
      cacheSet(ND_ENRICHED_CACHE_NS, hit.url, meta, TTL.enriched);
      cacheSet("ortmeta", embedUrl, meta, TTL.enriched);
      cacheSet(ND_RECOMMEND_CACHE_NS, cacheKey, { target: meta.target, pageUrl: hit.url }, TTL.ndrecommend);
      return meta.target;
    })().finally(() => newdeafRecommendationInflight.delete(cacheKey));
    newdeafRecommendationInflight.set(cacheKey, pending);
    return pending;
  }

  function recommendationLiftwHints(item) {
    return {
      title: movieTitle(item) || item?.title || "",
      originalTitle: item?.originalTitle || item?.alternativeName || item?.enName || "",
      year: item?.year || null,
      isSeries: !!item?.isSeries,
    };
  }

  // Newdeaf, Collaps and LiftW are all reached from the viewer's browser. For a
  // recommendation click they can therefore race without spending shared
  // resolver capacity; the first verified source wins and every slower result
  // merely warms its own cache for a later retry.
  async function resolveRecommendationPlaybackSource(item, selection) {
    const kpId = String(item?.kpId || item?.target?.kpId || "");
    if (!/^\d+$/.test(kpId)) return null;
    const ort = resolveRecommendationTarget(item)
      .then((target) => target ? { kind: "ort", target } : null)
      .catch((error) => { log("newdeaf-recommend-warn", error.message); return null; });
    const collaps = (collapsPreviewOnCooldown()
      ? Promise.resolve(null)
      : probeCollapsMovie({ ...item, kpId, selection, rank: 0 }))
      .then((hit) => hit ? { kind: "clps", hit } : null)
      .catch((error) => {
        if (shouldCooldownCollapsPreview(error)) setCollapsPreviewCooldown(error);
        log("collaps-recommend-warn", error.message);
        return null;
      });
    const liftw = findLiftwByKpId(kpId, recommendationLiftwHints(item))
      .then((liftId) => liftId ? { kind: "lift", liftId } : null)
      .catch((error) => { log("liftw-recommend-warn", error.message); return null; });
    return firstAvailable([ort, collaps, liftw]);
  }

  async function prepareRecommendation(item) {
    if (!item?.target?.kind) return;
    const source = await resolveRecommendationPlaybackSource(item, item?.selection);
    if (source?.kind === "ort") return prepareTarget(source.target, item);
    if (source?.kind === "clps") return prepareTarget({ kind: "clps", kpId: item.target.kpId }, item);
    if (source?.kind === "lift") {
      warmLiftwConnections();
      return resolveLiftwTitle(source.liftId);
    }
    return null;
  }

  function openRecommendationItem(item) {
    if (!item?.target?.kind || item.target.kind !== "kp") return openCuratedItem(item);
    const kpId = String(item.kpId || item.target.kpId || "");
    if (/^\d+$/.test(kpId)) {
      recommendationContextByKp.set(kpId, { ...item, kpId });
      if (recommendationContextByKp.size > 40) {
        recommendationContextByKp.delete(recommendationContextByKp.keys().next().value);
      }
    }
    // Pointer-down normally started this already. Calling it again is free: all
    // three provider helpers dedupe their in-flight work. Navigation itself is
    // synchronous, so the old page disappears immediately instead of waiting on
    // Newdeaf before even showing the new poster/player shell.
    prepareRecommendation(item).catch((error) => log("recommendation-open-warm-warn", error.message));
    return openCuratedItem({ ...item, kpId: /^\d+$/.test(kpId) ? kpId : item.kpId });
  }

  async function prepareTarget(target, details = {}) {
    if (!target?.kind) return;
    const prepKey = keyFor(target);
    if (preparedTargets.has(prepKey)) return;
    preparedTargets.add(prepKey);
    try {
      if (target.kind === "kp") {
        const zonaEmbedUrl = cacheGet("zona", target.kpId)?.embedUrl || "";
        if (zonaEmbedUrl) ensureShaka().catch(() => {});
        if (!collapsPreviewOnCooldown()) {
          warmCollapsConnections();
          try {
            await probeCollapsMovie({ ...details, kpId: String(target.kpId), rank: 0 });
          } catch (error) {
            if (shouldCooldownCollapsPreview(error)) setCollapsPreviewCooldown(error);
            throw error;
          }
        } else if (zonaEmbedUrl) {
          await ensureShaka();
          await warmZenithParsed(zonaEmbedUrl, details);
        }
      } else if (target.kind === "clps") {
        warmCollapsConnections();
        const playlist = await fetchCollapsPlaylist(target.kpId);
        const item = playlist.items.find((entry) =>
          (!target.season || entry.season === target.season) &&
          (!target.episode || entry.episode === target.episode)) || chooseCollapsProbeItem(playlist.items);
        if (item?.vkId) await fetchCollapsVideo(item.vkId);
      } else if (target.kind === "soap") {
        if (window.MediaSource) ensureHls().catch(() => {});
        const movies = await loadSoapCatalog();
        const movie = movies.find((entry) => String(entry.id) === String(target.soapId));
        if (movie) prefetchTopSoapManifest([movie]);
      } else if (target.kind === "zen") {
        // Curated shelves are mostly zen: items, and their whole click-to-play
        // cost is "load Shaka" + "resolve this embed". Warming both on intent is
        // what turns a click into an immediate player instead of a spinner.
        await ensureShaka();
        await warmZenithParsed(`https://api.zenithjs.ws/embed/movie/${encodeURIComponent(target.zenithId)}`, details);
      } else if (target.kind === "opr") {
        await ensureShaka();
      } else if (target.kind === "ort") {
        await fetchCachedEmbedText(target.embedUrl, { preferSandbox: true, label: "ortified-intent" });
      } else if (target.kind === "nd") {
        const parsed = await resolveNewdeafPage(target.pageUrl);
        const embedUrl = parsed?.ortified?.[0];
        if (embedUrl) await fetchCachedEmbedText(embedUrl, { preferSandbox: true, label: "ortified-intent" });
      }
    } catch (error) {
      preparedTargets.delete(prepKey);
      throw error;
    }
  }

  function armIntent(card, prepare, label) {
    if (!card || typeof prepare !== "function") return;
    let timer = null;
    let claimedSpeculativeSlot = false;
    const run = (speculative) => {
      if (speculative) {
        if (claimedSpeculativeSlot) return;
        if (!claimSpeculativeIntent()) return;
        claimedSpeculativeSlot = true;
      }
      prepare(speculative).catch((error) => log(label, error.message));
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => run(true), 220);
    };
    const cancel = () => { clearTimeout(timer); timer = null; };
    card.addEventListener("pointerenter", schedule, { passive: true });
    card.addEventListener("pointerleave", cancel, { passive: true });
    card.addEventListener("focus", schedule);
    card.addEventListener("blur", cancel);
    card.addEventListener("pointerdown", () => run(false), { passive: true });
  }

  function armCardIntent(card, target, details = {}) {
    if (!target?.kind) return;
    armIntent(card, () => prepareTarget(target, details), "intent-prefetch-warn");
  }

  function armRecommendationIntent(card, item) {
    if (!item?.target?.kind) return;
    armIntent(card, (speculative) => {
      if (speculative) {
        if (speculativeRecommendationBudget <= 0) return Promise.resolve();
        speculativeRecommendationBudget -= 1;
      }
      return prepareRecommendation(item);
    }, "recommendation-prefetch-warn");
  }

  function pageUrlCandidates(pageUrl) {
    const original = new URL(pageUrl);
    if (!/^\d{1,2}[a-z]{3}\.newdeaf\.co$/i.test(original.host)) return [original.href];
    return dailyMirrorCandidates(original.origin).map((mirror) => {
      const candidate = new URL(original.href);
      const mirrorUrl = new URL(mirror);
      candidate.protocol = mirrorUrl.protocol;
      candidate.host = mirrorUrl.host;
      return candidate.href;
    });
  }

  function dailyMirrorCandidates(explicitOrigin) {
    // newdeaf serves a {DD}{mon}.newdeaf.co mirror for the current Moscow date and
    // rolls it over around midnight–02:00 MSK, killing the previous day's host.
    // Probe today's MSK date first, then yesterday and tomorrow so we can't miss
    // the live host whichever side of midnight it is (the earlier code shifted the
    // clock back 2h and probed a dead yesterday-mirror when today's was already up).
    // First host that parses wins, so the others aren't hit.
    const mskNow = Date.now() + 3 * 3600000;
    const slug = (offsetDays) => {
      const date = new Date(mskNow + offsetDays * 86400000);
      return `https://${date.getUTCDate()}${monthSlug(date)}.newdeaf.co`;
    };
    const generated = [slug(0), slug(-1), slug(1)];
    return unique([explicitOrigin, ...generated].filter(Boolean).map((value) => cleanBaseUrl(value)));
  }
  function monthSlug(date) {
    return ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"][date.getUTCMonth()];
  }

  function isNewdeafPage(href, base) {
    const url = cleanUrl(href, base);
    if (!url) return null;
    const parsed = new URL(url);
    // Daily-mirror hosts (17jun.newdeaf.co) 301-redirect to the apex newdeaf.co, so
    // result links come back on EITHER the mirror host or the apex (and which one is
    // geo-dependent). Accept the whole newdeaf.co family instead of demanding an
    // exact match with the mirror we requested — that strict check silently dropped
    // every result after the redirect.
    if (!/(^|\.)newdeaf\.co$/i.test(parsed.host)) return null;
    if (!/\.html(?:$|[?#])/i.test(parsed.href)) return null;
    if (!/(\/film\/|\/serial\/|\/multfilm\/|\/anime\/|\/multserial\/|\/multserialy\/)/i.test(parsed.pathname)) return null;
    return parsed.href;
  }

  function parseNewdeafSearch(html, base) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const seen = new Set();
    const out = [];
    // newdeaf's DLE "card" layout: <article class="card"> wraps a poster anchor
    // (a.card__img with img[data-src]) AND a title anchor (h2.card__title a).
    // Iterate the card containers and pull the title from the title element so we
    // get a clean name ("Рик и Морти (1 сезон) - русские субтитры") instead of the
    // whole card's text blob. The poster lives in img[data-src] (src is a 1x1
    // lazy-load placeholder). Fall back to a generic anchor scan for other skins.
    for (const card of doc.querySelectorAll("article.card, .card, .th-item, .short, .shortstory")) {
      const titleLink = card.querySelector(".card__title a, h2 a, .th-title a, .short_header a, h3 a");
      const anyLink = titleLink || card.querySelector("a[href]");
      if (!anyLink) continue;
      const href = isNewdeafPage(anyLink.getAttribute("href"), base);
      if (!href || seen.has(href)) continue;
      const titleEl = card.querySelector(".card__title, .th-title, .short_header, h2, h3");
      let title = cleanNewdeafTitle(compact(titleEl ? titleEl.textContent : (titleLink ? titleLink.textContent : "")));
      if (!title) title = cleanNewdeafTitle(compact(anyLink.getAttribute("title"))) || new URL(href).pathname.split("/").pop();
      const img = card.querySelector("img[data-src], img[data-original], img[src]");
      const poster = img ? cleanUrl(img.getAttribute("data-src") || img.getAttribute("data-original") || img.getAttribute("src"), base) : null;
      seen.add(href);
      out.push({ url: href, title, poster });
      if (out.length >= 20) break;
    }
    if (out.length) return out;

    for (const a of doc.querySelectorAll("a[href]")) {
      const href = isNewdeafPage(a.getAttribute("href"), base);
      if (!href || seen.has(href)) continue;
      seen.add(href);
      const card = a.closest("article, .short, .shortstory, .story, .item, .th-item, .movie-item") || a.parentElement;
      const title = compact(a.textContent) || compact(card && card.textContent).slice(0, 140) || new URL(href).pathname.split("/").pop();
      const img = card && card.querySelector && card.querySelector("img[data-src], img[data-original], img[src]");
      const poster = img ? cleanUrl(img.getAttribute("data-src") || img.getAttribute("data-original") || img.getAttribute("src"), base) : null;
      out.push({ url: href, title, poster });
      if (out.length >= 20) break;
    }
    return out;
  }

  function isNewdeafSearchDocument(html) {
    const text = String(html || "");
    if (text.length < 5000) return false;
    return /(?:id=["']quicksearch["']|name=["']story["'])/i.test(text) &&
      /(?:newdeaf|Новый мир глухих)/i.test(text);
  }

  function parseNewdeafPage(html, pageUrl) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const ortified = [];
    const opravar = [];
    const allo = [];
    const add = (list, value, re) => {
      const cleaned = cleanUrl(value, pageUrl);
      if (cleaned && re.test(cleaned) && !list.includes(cleaned)) list.push(cleaned);
    };
    for (const node of doc.querySelectorAll("iframe[src], [data-src], [data-url], [src]")) {
      const value = node.getAttribute("src") || node.getAttribute("data-src") || node.getAttribute("data-url");
      add(ortified, value, /^https:\/\/api\.ortified\.ws\/embed\//i);
      add(opravar, value, /^https:\/\/(?:gencit\.info|opravar\.online)\/bil\/\d+/i);
      add(allo, value, /^https:\/\/allo\.cdnlbox\.club\//i);
    }
    const text = html.replace(/&amp;/g, "&");
    for (const match of text.matchAll(/https:\/\/api\.ortified\.ws\/embed\/[^"'<>\s)]+/gi)) add(ortified, match[0], /^https:\/\/api\.ortified\.ws\/embed\//i);
    for (const match of text.matchAll(/https:\/\/(?:gencit\.info|opravar\.online)\/bil\/\d+[^"'<>\s)]*/gi)) add(opravar, match[0], /^https:\/\/(?:gencit\.info|opravar\.online)\/bil\/\d+/i);
    for (const match of text.matchAll(/https:\/\/allo\.cdnlbox\.club\/[^"'<>\s)]+/gi)) add(allo, match[0], /^https:\/\/allo\.cdnlbox\.club\//i);

    const title = cleanNewdeafTitle(
      compact(doc.querySelector('meta[property="og:title"]')?.getAttribute("content")) ||
      compact(doc.querySelector("h1")?.textContent) ||
      compact(doc.querySelector("title")?.textContent)
    );
    const description =
      compact(doc.querySelector('meta[property="og:description"]')?.getAttribute("content")) ||
      compact(doc.querySelector('meta[name="description"]')?.getAttribute("content"));
    const poster = cleanUrl(doc.querySelector('meta[property="og:image"], meta[name="og:image"]')?.getAttribute("content"), pageUrl);
    const year = extractYear(`${title} ${description} ${pageUrl}`);
    return { title, description, poster, year, ortified, opravar, allo };
  }

  function parseZenithEmbed(html) {
    const text = String(html || "");
    const sources = {};
    for (const match of text.matchAll(/\b(dash|dasha|hls)\s*:\s*("(?:(?:\\.|[^"\\])*)"|'(?:(?:\\.|[^'\\])*)')/g)) {
      sources[match[1]] = decodeJsString(match[2]).replace(/&amp;/g, "&");
    }
    const fallbackText = text.replace(/\\\//g, "/").replace(/&amp;/g, "&");
    if (!sources.dash) sources.dash = firstUrl(fallbackText, /\.mpd(?:\?|$)/i);
    if (!sources.hls) sources.hls = firstUrl(fallbackText, /(?:\.m3u8|master\.m3u8)(?:\?|$)/i);
    const playlist = parseZenithPlaylist(text);
    const currentEpisode = findSerialEpisode(playlist.seasons, playlist.current);
    if (currentEpisode) Object.assign(sources, currentEpisode.sources);
    const titleMatch = text.match(/\btitle\s*:\s*("(?:(?:\\.|[^"\\])*)"|'(?:(?:\\.|[^'\\])*)')/);
    const audioMatch = text.match(/\baudio\s*:\s*\{\s*["']?names["']?\s*:\s*\[([^\]]*)\]/);
    const soundBlockMatch = text.match(/\bsoundBlock\s*:\s*("(?:(?:\\.|[^"\\])*)"|'(?:(?:\\.|[^'\\])*)')/);
    const rawAudioNames = audioMatch
      ? [...audioMatch[1].matchAll(/("(?:(?:\\.|[^"\\])*)"|'(?:(?:\\.|[^'\\])*)')/g)].map((match) => decodeJsString(match[1]))
      : [];
    return {
      sources,
      meta: {
        title: titleMatch ? decodeJsString(titleMatch[1]) : "",
        audioNames: normalizeAudioNames(rawAudioNames),
        blockedAudioNames: soundBlockMatch
          ? decodeJsString(soundBlockMatch[1]).split(",").map((name) => compact(name)).filter(Boolean)
          : [],
      },
      playlist,
    };
  }

  function parseZenithPlaylist(text) {
    const playlistMatch = /\bplaylist\s*:\s*\{/.exec(text);
    if (!playlistMatch) return { current: null, seasons: [] };
    const tail = text.slice(playlistMatch.index);
    const seasonsMatch = /\bseasons\s*:\s*\[/.exec(tail);
    if (!seasonsMatch) return { current: null, seasons: [] };
    const arrayStart = playlistMatch.index + seasonsMatch.index + seasonsMatch[0].lastIndexOf("[");
    const arrayText = balancedJsContainer(text, arrayStart, "[", "]");
    if (!arrayText) return { current: null, seasons: [] };

    let rawSeasons;
    try {
      rawSeasons = JSON.parse(arrayText);
    } catch {
      return { current: null, seasons: [] };
    }
    const beforeSeasons = text.slice(playlistMatch.index, arrayStart);
    const currentMatch = beforeSeasons.match(
      /\bcurrent\s*:\s*\{\s*season\s*:\s*(\d+)\s*,\s*episode\s*:\s*(?:"([^"]+)"|'([^']+)'|(\d+))/,
    );
    return {
      current: currentMatch
        ? { season: Number(currentMatch[1]), episode: Number(currentMatch[2] || currentMatch[3] || currentMatch[4]) }
        : null,
      seasons: normalizeSerialSeasons(rawSeasons),
    };
  }

  function balancedJsContainer(text, start, open, close) {
    if (text[start] !== open) return "";
    let depth = 0;
    let quote = "";
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (quote) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === quote) quote = "";
        continue;
      }
      if (char === '"' || char === "'" || char === "`") {
        quote = char;
        continue;
      }
      if (char === open) depth += 1;
      else if (char === close) {
        depth -= 1;
        if (depth === 0) return text.slice(start, index + 1);
      }
    }
    return "";
  }

  function firstUrl(text, kindRe) {
    for (const match of text.matchAll(/https?:\/\/[^"'<>\s\\]+/g)) {
      const url = match[0].replace(/[),.;]+$/, "");
      if (kindRe.test(url)) return url;
    }
    return "";
  }

  function sanitizeOrtifiedHtml(html, embedUrl, mode) {
    let out = String(html || "");
    const baseHref = new URL(embedUrl).origin + "/";
    const stats = {
      mode,
      ok: false,
      tizenPatched: false,
      adScriptBlocks: (out.match(/<script\s+data-name=["']ad["'][\s\S]*?<\/script>/gi) || []).length,
      makePlayerRefs: (out.match(/makePlayer\s*\(/g) || []).length,
    };
    out = out.replace(/<script\s+data-name=["']ad["'][\s\S]*?<\/script>/i, '<script data-name="ad">var middleCount = 0, adsConfig = {};</' + "script>");
    out = out.replace(/ads:\s*adsConfig\s*,/g, "ads: {},");
    if (TIZEN_VIDEO_MODE) {
      // Venom trusts MediaSource.isTypeSupported and otherwise prefers its WebM
      // ladders. Samsung advertises them but the LSP3 cannot always decode them
      // in real time. Apply this immediately before Venom consumes the options:
      // retain H.264 HLS, and shed P2P/WebRTC plus preview sprite work.
      const original = out;
      out = out.replace(/app\s*=\s*VenomPlayer\.make\(opts\)/, `
        if (window.__ALPHY_TIZEN_VIDEO__) {
          const hlsOnly = (source) => {
            if (!source || !source.hls) return;
            delete source.dash;
            delete source.dasha;
          };
          hlsOnly(opts.source);
          ((opts.playlist && opts.playlist.seasons) || []).forEach((season) => {
            (season.episodes || []).forEach(hlsOnly);
          });
          opts.p2p = false;
          opts.preview = false;
          opts.stats = [];
        }
        app = VenomPlayer.make(opts)`);
      stats.tizenPatched = out !== original;
    }
    if (!/<base\s/i.test(out) && /<head([^>]*)>/i.test(out)) out = out.replace(/<head([^>]*)>/i, `<head$1><base href="${escapeAttr(baseHref)}">`);
    if (!/<base\s/i.test(out)) out = out.replace(/<html([^>]*)>/i, `<html$1><head><base href="${escapeAttr(baseHref)}"></head>`);
    const tizenFlag = TIZEN_VIDEO_MODE
      ? '<script>window.__ALPHY_TIZEN_VIDEO__=true;</' + 'script>'
      : "";
    out = out.replace(/<head([^>]*)>/i, `<head$1>${tizenFlag}${adBlockPrelude()}${progressHook()}<style>html,body{margin:0;background:#000;min-height:100%;height:100%;overflow:hidden;}</style>`);
    stats.ok = stats.makePlayerRefs > 0;
    return { html: out, stats };
  }

  function adBlockPrelude() {
    return `<script data-cleanroom="ad-block-prelude">
(() => {
  const blocked = [/vuegenesisvue\\.com/i,/buzzoola/i,/targetads\\.io/i,/ufouxbwn\\.com/i,/getaim\\.org/i,/yandex\\.ru/i,/aidata\\.io/i,/a\\.mts\\.ru/i,/cm\\.a\\.mts\\.ru/i,/trk\\.mail\\.ru/i,/timing-js-menu\\.xyz/i];
  const isBlocked = (value) => {
    try {
      const url = typeof value === 'string' ? value : value && (value.url || value.src || value.href);
      return !!url && blocked.some((re) => re.test(String(url)));
    } catch (e) { return false; }
  };
  const nativeFetch = window.fetch && window.fetch.bind(window);
  if (nativeFetch) window.fetch = (input, init) => isBlocked(typeof input === 'string' ? input : input && input.url) ? Promise.reject(new TypeError('cleanroom blocked fetch')) : nativeFetch(input, init);
  const nativeOpen = XMLHttpRequest && XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest && XMLHttpRequest.prototype.send;
  if (nativeOpen && nativeSend) {
    XMLHttpRequest.prototype.open = function(method, url) { this.__cleanroomBlocked = isBlocked(url); return nativeOpen.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function() { if (this.__cleanroomBlocked) { setTimeout(() => { try { this.dispatchEvent(new Event('error')); this.dispatchEvent(new Event('loadend')); } catch (e) {} }, 0); return; } return nativeSend.apply(this, arguments); };
  }
})();
<\/script>`;
  }

  // =====================================================================
  // small helpers
  // =====================================================================
  function buildCollapsContext(playlist) {
    const items = Array.isArray(playlist?.items) ? playlist.items : [];
    if (!playlist?.isSerial) {
      return {
        provider: "collaps",
        kpId: playlist?.kpId || "",
        titleName: playlist?.titleName || "",
        isSerial: false,
        voices: items,
        seasons: [],
      };
    }

    const seasonMap = new Map();
    for (const item of items) {
      const seasonNumber = positiveInt(item.season) || 1;
      const episodeNumber = positiveInt(item.episode) || 1;
      if (!seasonMap.has(seasonNumber)) seasonMap.set(seasonNumber, new Map());
      const episodeMap = seasonMap.get(seasonNumber);
      if (!episodeMap.has(episodeNumber)) episodeMap.set(episodeNumber, []);
      episodeMap.get(episodeNumber).push(item);
    }
    const seasons = [...seasonMap.entries()]
      .map(([season, episodeMap]) => ({
        season,
        episodes: [...episodeMap.entries()]
          .map(([episode, voices]) => ({ episode, voices }))
          .sort((a, b) => a.episode - b.episode),
      }))
      .filter((season) => season.episodes.length)
      .sort((a, b) => a.season - b.season);
    return {
      provider: "collaps",
      kpId: playlist?.kpId || "",
      titleName: playlist?.titleName || "",
      isSerial: true,
      voices: [],
      seasons,
    };
  }

  function collapsVoicesForSelection(context, selection) {
    if (!context?.isSerial) return context?.voices || [];
    const picked = chooseCollapsSelection(context, selection);
    const season = context.seasons.find((item) => item.season === picked?.season);
    const episode = season?.episodes.find((item) => item.episode === picked?.episode);
    return episode?.voices || [];
  }

  function preferredCollapsVoiceIndex(voices, requested = {}) {
    const list = Array.isArray(voices) ? voices : [];
    const requestedName = compact(requested.voiceName || "");
    if (requestedName) {
      const exact = list.findIndex((item, index) =>
        normalizedTrackName(collapsVoiceLabel(item, index)) === normalizedTrackName(requestedName));
      if (exact >= 0) return exact;
      const similar = list.findIndex((item, index) =>
        similarTrackName(collapsVoiceLabel(item, index), requestedName));
      if (similar >= 0) return similar;
    }
    const byVk = list.findIndex((item) => requested.vkId && item.vkId === requested.vkId);
    if (byVk >= 0) return byVk;
    if (Number.isInteger(requested.voiceIndex) && list[requested.voiceIndex]) return requested.voiceIndex;
    return 0;
  }

  function chooseCollapsSelection(context, requested = {}) {
    if (!context) return null;
    const req = normalizeCollapsSelection(requested) || {};
    if (!context.isSerial) {
      const voices = context.voices || [];
      const voiceIndex = preferredCollapsVoiceIndex(voices, req);
      const item = voices[voiceIndex];
      return item ? {
        voiceIndex,
        vkId: item.vkId,
        voiceName: collapsVoiceLabel(item, voiceIndex),
        item,
        ...(req.qualityKey ? { qualityKey: req.qualityKey } : {}),
      } : null;
    }

    const seasons = context.seasons || [];
    const season = seasons.find((item) => item.season === req.season) || seasons[0];
    const episode =
      season?.episodes.find((item) => item.episode === req.episode) ||
      season?.episodes[0];
    const voices = episode?.voices || [];
    const voiceIndex = preferredCollapsVoiceIndex(voices, req);
    const item = voices[voiceIndex];
    return item ? {
      season: season.season,
      episode: episode.episode,
      voiceIndex,
      vkId: item.vkId,
      voiceName: collapsVoiceLabel(item, voiceIndex),
      item,
      ...(req.qualityKey ? { qualityKey: req.qualityKey } : {}),
    } : null;
  }

  function sameCollapsSelection(a, b) {
    return !!a && !!b &&
      Number(a.season || 0) === Number(b.season || 0) &&
      Number(a.episode || 0) === Number(b.episode || 0) &&
      String(a.vkId || "") === String(b.vkId || "") &&
      String(a.qualityKey || "") === String(b.qualityKey || "");
  }

  function cleanCollapsSelection(value = {}) {
    const out = {};
    const season = positiveInt(value.season);
    const episode = positiveInt(value.episode);
    const voiceIndex = Number.parseInt(String(value.voiceIndex ?? ""), 10);
    if (season) out.season = season;
    if (episode) out.episode = episode;
    if (Number.isInteger(voiceIndex) && voiceIndex >= 0) out.voiceIndex = voiceIndex;
    if (value.vkId) out.vkId = String(value.vkId);
    if (value.voiceName) out.voiceName = String(value.voiceName).slice(0, 120);
    if (collapsQualityByKey(value.qualityKey)) out.qualityKey = String(value.qualityKey);
    return out;
  }

  function normalizeCollapsSelection(value = {}) {
    if (!value || typeof value !== "object") return null;
    const selection = cleanCollapsSelection(value);
    return Object.keys(selection).length ? selection : null;
  }

  function serialSelectionFromEpisodeKey(value) {
    const match = String(value || "").match(/^s(\d+)e(\d+)$/i);
    return match ? { season: Number(match[1]), episode: Number(match[2]) } : null;
  }

  function collapsQualityByKey(key) {
    return COLLAPS_QUALITY_FIELDS.find(([field]) => field === key) || null;
  }

  function chooseCollapsSource(sources, qualityKey = "") {
    const list = Array.isArray(sources) ? sources : [];
    const explicit = list.find((source) => source.key === qualityKey);
    if (explicit) return explicit;
    const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    const effective = String(connection?.effectiveType || "").toLowerCase();
    const downlink = Number(connection?.downlink || 0);
    const cap = connection?.saveData || /(^|-)2g$/.test(effective)
      ? 480
      : effective === "3g" || (downlink > 0 && downlink < 5)
        ? 720
        : 1080;
    // Progressive MP4 cannot adapt after startup. Begin at a quality that reaches
    // first frame quickly; 2K/4K remain one tap away and an explicit saved choice
    // always wins on the next open.
    return list.find((source) => Number(source.height || 0) <= cap) || list[list.length - 1] || null;
  }

  function initialBandwidthEstimate(fallback) {
    const nav = globalThis.navigator || {};
    const connection = nav.connection || nav.mozConnection || nav.webkitConnection;
    const effective = String(connection?.effectiveType || "").toLowerCase();
    const downlink = Number(connection?.downlink || 0);
    if (connection?.saveData || /(^|-)2g$/.test(effective)) return 700_000;
    if (effective === "3g") return 1_800_000;
    if (downlink > 0) return Math.max(900_000, Math.min(10_000_000, downlink * 650_000));
    return fallback;
  }

  function collapsVoiceLabel(item, index = 0) {
    return [item?.voiceStudio, item?.voiceType].filter(Boolean).join(" · ") ||
      item?.name ||
      `Озвучка ${index + 1}`;
  }

  function normalizeSerialSeasons(value) {
    return (Array.isArray(value) ? value : [])
      .map((season) => ({
        season: positiveInt(season?.season ?? season?.number),
        episodes: (Array.isArray(season?.episodes) ? season.episodes : [])
          .map((episode) => ({
            episode: positiveInt(episode?.episode ?? episode?.number ?? episode?.episodeNumber),
            title: compact(episode?.title || episode?.name || episode?.nameRu || episode?.nameEn || ""),
            id: positiveInt(episode?.id),
            videoKey: positiveInt(episode?.videoKey),
            sources: zenithEpisodeSources(episode?.sources || episode),
            // Озвучка names and .vtt tracks are per-episode on LiftW (a season
            // can change studios mid-run). Zenith simply has neither and gets
            // empty arrays. Read both the raw and the already-normalized shape:
            // chooseSerialSelection re-normalizes lists it was handed earlier.
            audioNames: embedAudioNames(episode),
            textTracks: embedTextTracks(episode),
          }))
          .filter((episode) => episode.episode && Object.keys(episode.sources).length)
          .sort((a, b) => a.episode - b.episode),
      }))
      .filter((season) => season.season && season.episodes.length)
      .sort((a, b) => a.season - b.season);
  }

  function chooseSerialSelection(seasons, requested) {
    const list = normalizeSerialSeasons(seasons);
    if (!list.length) return null;
    const season = list.find((item) => item.season === positiveInt(requested?.season)) || list[0];
    const episode =
      season.episodes.find((item) => item.episode === positiveInt(requested?.episode)) ||
      season.episodes[0];
    return episode ? { season: season.season, episode: episode.episode } : null;
  }

  function sameSerialSelection(a, b) {
    return !!a && !!b &&
      Number(a.season) === Number(b.season) &&
      Number(a.episode) === Number(b.episode);
  }

  function positiveInt(value) {
    const parsed = Number.parseInt(String(value ?? ""), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  function normalizeSerialHint(value) {
    const season = positiveInt(value?.season);
    const episode = positiveInt(value?.episode);
    if (!season && !episode) return null;
    return {
      ...(season ? { season } : {}),
      ...(episode ? { episode } : {}),
    };
  }

  // Newdeaf has a separate result/page for each season, while the fallback
  // providers expose one combined serial playlist. Preserve the page's explicit
  // season/episode instead of letting Zenith/Opravar pick an unrelated
  // playlist.current. Query parameters are authoritative; title/path patterns
  // cover Allo-only pages that have no selectable player query.
  function newdeafSerialHint(...values) {
    let season = null;
    let episode = null;
    const textParts = [];
    for (const value of values) {
      const text = String(value || "");
      if (!text) continue;
      textParts.push(text);
      try {
        const url = new URL(text);
        season ||= positiveInt(url.searchParams.get("season"));
        episode ||= positiveInt(url.searchParams.get("episode"));
        textParts.push(decodeURIComponent(url.pathname.replace(/[+_-]+/g, " ")));
      } catch {
        // A title is expected to land here.
      }
    }

    const text = compact(textParts.join(" "));
    season ||= positiveInt(
      text.match(/(?:сезон|season|sezon)\s*(?:№|#|:|-)?\s*(\d{1,3})(?!\d)/i)?.[1] ||
      text.match(/(?:^|\D)(\d{1,3})\s*(?:сезон|season|sezon)(?![a-zа-яё])/i)?.[1] ||
      text.match(/(?:^|[\s/_-])s(?:eason|ezon)?[\s_-]?(\d{1,3})(?:$|[\s/_.-])/i)?.[1],
    );
    episode ||= positiveInt(
      text.match(/(?:серия|эпизод|episode|seriya|epizod|ep)\s*(?:№|#|:|-)?\s*(\d{1,4})(?!\d)/i)?.[1] ||
      text.match(/(?:^|\D)(\d{1,4})\s*(?:серия|эпизод|episode|seriya|epizod)(?![a-zа-яё])/i)?.[1] ||
      text.match(/(?:^|[\s/_.-])e(?:p(?:isode)?)?[\s_-]?(\d{1,4})(?:$|[\s/_.-])/i)?.[1],
    );
    return normalizeSerialHint({ season, episode });
  }

  function zenithEpisodeSources(value) {
    const sources = {};
    for (const key of ["dash", "dasha", "hls"]) {
      const url = String(value?.[key] || "").replace(/&amp;/g, "&");
      if (/^https:\/\//i.test(url)) sources[key] = url;
    }
    return sources;
  }

  function embedAudioNames(episode) {
    const names = Array.isArray(episode?.audioNames) ? episode.audioNames : episode?.audio?.names;
    return normalizeAudioNames(names);
  }

  function normalizeAudioNames(names) {
    // The manifest suffix (rus0, eng7) addresses this array by position. Keep
    // empty/blocked slots in place or every name after one shifts to a wrong dub.
    return (Array.isArray(names) ? names : [])
      .slice(0, 24)
      .map((name) => compact(name).slice(0, 60));
  }

  function embedTextTracks(episode) {
    const raw = Array.isArray(episode?.textTracks) ? episode.textTracks : episode?.cc;
    return (Array.isArray(raw) ? raw : [])
      .map((track) => {
        const url = String(track?.url || "").replace(/&amp;/g, "&");
        const label = compact(track?.label || track?.name).slice(0, 60);
        return { url, label, language: track?.language || liftwSubtitleLanguage(label) };
      })
      .filter((track) => /^https:\/\/[a-z0-9-]+\.interkh\.com\//i.test(track.url))
      .slice(0, 12);
  }

  function findSerialEpisode(seasons, selection) {
    const season = (Array.isArray(seasons) ? seasons : []).find((item) => item.season === selection?.season);
    return season?.episodes.find((item) => item.episode === selection?.episode) || null;
  }

  function bestZenithSource(sources) {
    if (TIZEN_VIDEO_MODE && sources?.hls) return { url: sources.hls, kind: "hls" };
    if (sources?.dash) return { url: sources.dash, kind: "dash" };
    if (sources?.hls) return { url: sources.hls, kind: "hls" };
    if (sources?.dasha) return { url: sources.dasha, kind: "dasha" };
    return null;
  }

  function chooseOpravarSelection(playlist, requested) {
    const seasons = Array.isArray(playlist) ? playlist : [];
    if (!seasons.length) return null;
    const season = seasons.find((item) => item.season === Number(requested?.season)) || seasons[0];
    const positiveEpisodes = season.episodes.filter((item) => item.episode > 0);
    const episode =
      season.episodes.find((item) => item.episode === Number(requested?.episode)) ||
      positiveEpisodes[0] ||
      season.episodes[0];
    if (!episode) return null;
    const requestedVoiceName = compact(requested?.voiceName || "");
    const voice =
      (requestedVoiceName && episode.voices.find((item) =>
        normalizedTrackName(item.name) === normalizedTrackName(requestedVoiceName))) ||
      (requestedVoiceName && episode.voices.find((item) =>
        similarTrackName(item.name, requestedVoiceName))) ||
      episode.voices.find((item) => item.voiceId === Number(requested?.voiceId)) ||
      episode.voices.find((item) => item.voiceId === 2) ||
      episode.voices[0];
    if (!voice) return null;
    return {
      season: season.season,
      episode: episode.episode,
      voiceId: voice.voiceId,
      videoId: voice.videoId,
      voiceName: voice.name,
    };
  }

  function sameOpravarSelection(a, b) {
    return !!a && !!b &&
      Number(a.season) === Number(b.season) &&
      Number(a.episode) === Number(b.episode) &&
      Number(a.voiceId) === Number(b.voiceId) &&
      (!a.videoId || !b.videoId || Number(a.videoId) === Number(b.videoId));
  }

  function chooseMovie(results, title, year) {
    if (!Array.isArray(results) || !results.length) return null;
    const normalized = normalizeTitle(title);
    return results.find((movie) => year && String(movie.year) === String(year) && normalizeTitle(movieTitle(movie)).includes(normalized.slice(0, 12))) ||
      results.find((movie) => year && String(movie.year) === String(year)) ||
      results[0];
  }

  // Newdeaf search results often share one generic token ("Бэтмен") while being
  // completely different films ("Лего Фильм: Бэтмен", "Бэтмен-ниндзя", ...).
  // Metadata enrichment must fail closed: a blank rating is harmless, a confident
  // looking cover/year copied from another title is not.
  function matchNewdeafMetadata(item, movies) {
    if (!item?.title || !Array.isArray(movies) || !movies.length) return null;
    const wanted = normalizeTitle(item.title);
    if (!wanted) return null;
    const pageYear = extractYear(`${item.title || ""} ${item.url || ""}`);
    const pageType = newdeafPageType(item);
    let exact = movies.filter((movie) =>
      [movieTitle(movie), movie?.alternativeName, movie?.enName]
        .filter(Boolean)
        .some((name) => normalizeTitle(name) === wanted));
    if (pageType !== null) {
      exact = exact.filter((movie) => typeof movie?.isSeries !== "boolean" || movie.isSeries === pageType);
    }
    if (!exact.length) return null;
    if (pageYear) return exact.find((movie) => String(movie?.year || "") === pageYear) || null;
    if (exact.length === 1) return exact[0];
    const years = new Set(exact.map((movie) => String(movie?.year || "")).filter(Boolean));
    return years.size <= 1 ? exact[0] : null;
  }

  function newdeafPageType(item) {
    const title = String(item?.title || "");
    const href = String(item?.url || item?.pageUrl || "");
    if (newdeafSerialHint(title, href)?.season) return true;
    try {
      const path = new URL(href).pathname;
      if (/\/(?:serial|multserial|multserialy)\//i.test(path)) return true;
      if (/\/(?:film|multfilm)\//i.test(path)) return false;
    } catch { /* title-only candidates have no reliable type signal */ }
    return null;
  }

  function pickExactNewdeafResult(results, details) {
    const wanted = normalizeTitle(details?.title || "");
    if (!wanted || !Array.isArray(results)) return null;
    const wantedYear = String(details?.year || "");
    const wantedType = typeof details?.isSeries === "boolean" ? details.isSeries : null;
    const ranked = [];
    for (const candidate of results) {
      if (normalizeTitle(candidate?.title || "") !== wanted) continue;
      const candidateYear = extractYear(`${candidate.title || ""} ${candidate.url || ""}`);
      if (wantedYear && candidateYear && candidateYear !== wantedYear) continue;
      const candidateType = newdeafPageType(candidate);
      if (wantedType !== null && candidateType !== null && candidateType !== wantedType) continue;
      const serialHint = newdeafSerialHint(candidate.title || "", candidate.url || "");
      let score = 0;
      if (wantedYear && candidateYear === wantedYear) score += 8;
      if (wantedType !== null && candidateType === wantedType) score += 4;
      if (wantedType === true) {
        if (serialHint?.season === 1) score += 3;
        else if (serialHint?.season) score += 1 / serialHint.season;
      } else if (!serialHint?.season) {
        score += 2;
      }
      ranked.push({ candidate, score });
    }
    if (!wantedYear) {
      const knownYears = new Set(ranked.map(({ candidate }) =>
        extractYear(`${candidate.title || ""} ${candidate.url || ""}`)).filter(Boolean));
      if (knownYears.size > 1) return null;
    }
    ranked.sort((a, b) => b.score - a.score);
    return ranked[0]?.candidate || null;
  }

  function matchTitleTokens(value) {
    const cleaned = compact(value)
      .replace(/\([^)]*(?:сезон|season)[^)]*\)/gi, " ")
      .replace(/\d+\s*(?:сезон|season)/gi, " ")
      .replace(/(?:русские?|english|английские?)\s+субтитры/gi, " ")
      .replace(/(?:субтитры|subtitle[sd]?|смотреть|онлайн|online)/gi, " ")
      .replace(/\b(?:19|20)\d{2}\b/g, " ")
      .toLowerCase()
      .replace(/ё/g, "е")
      .replace(/[^a-zа-я0-9]+/gi, " ")
      .trim();
    return new Set(cleaned.split(/\s+/).filter((token) => token.length > 1));
  }

  function cleanNewdeafTitle(value) {
    // newdeaf's og:title is promo-padded ("… - смотреть онлайн с субтитрами").
    // Strip that tail so the player shows a clean name; keep season info.
    return compact(value)
      .replace(/\s*[-–—]\s*смотреть\s+онлайн.*$/i, "")
      .replace(/\s*смотреть\s+онлайн.*$/i, "")
      .replace(/\s*[-–—]\s*(?:русские?|english|английские?)\s+субтитры.*$/i, "")
      .replace(/\s*[-–—]\s*newdeaf.*$/i, "")
      .trim();
  }

  function cleanMovieTitle(value) {
    return compact(value)
      .replace(/^(фильм|сериал|мультфильм|аниме|мультсериал)\s+/i, "")
      .replace(/\([^)]*(?:сезон|season|sezon)[^)]*\)/gi, " ")
      .replace(/\d+\s*(?:сезон|season|sezon)/gi, " ")
      .replace(/(?:русские?|english|английские?)\s+субтитры/gi, " ")
      .replace(/(?:субтитры|subtitle[sd]?)/gi, " ")
      .replace(/\s*\((?:19|20)\d{2}\).*$/, "")
      .replace(/\s*смотреть.*$/i, "")
      .replace(/\s*[-–—]\s*$/, "")
      .trim();
  }
  function movieTitle(movie) {
    return movie?.name || movie?.alternativeName || movie?.enName || movie?.title || "";
  }
  function normalizeTitle(value) {
    return cleanMovieTitle(value).toLowerCase().replace(/ё/g, "е").replace(/[^a-zа-я0-9]+/gi, "");
  }
  // The embed ships the human dub names ("HDRezka Studio"); the manifest only
  // ships positional ones ("rus1"). The trailing digit is the index that joins
  // them. Read it from the label first, because on an HLS ladder the language is
  // the bare "ru" for every Russian dub and would map them all to names[0].
  function audioNameFor(track, fallbackIndex) {
    const names = state.audioNames || [];
    const language = typeof track === "string" ? track : track?.language;
    for (const candidate of [typeof track === "string" ? "" : track?.label, language]) {
      const suffix = String(candidate || "").match(/(\d+)$/);
      if (suffix && names[Number(suffix[1])]) return names[Number(suffix[1])];
    }
    if (names[fallbackIndex]) return names[fallbackIndex];
    return (typeof track === "string" ? track : track?.label || language) || "unknown";
  }
  function normalizedAudioName(value) {
    return compact(value).replace(/\s+/g, "").toLowerCase();
  }
  function isBlockedAudioName(value) {
    const name = normalizedAudioName(value);
    if (!name) return false;
    // Older cached parses predate blockedAudioNames. `delete` is player-venom's
    // own sentinel, never a user-facing dub, so keep that fallback permanent.
    return name === "delete" || (state.blockedAudioNames || []).some((blocked) => normalizedAudioName(blocked) === name);
  }
  function shakaAudioChoices(variants, includeBlocked = false) {
    const grouped = groupBy(
      variants,
      (track) => `${track.language || ""}|${track.label || ""}|${(track.roles || []).join(",")}`,
    );
    const choices = grouped.map((track, index) => {
      const name = audioNameFor(track, index);
      return { track, name, blocked: isBlockedAudioName(name) };
    });
    return includeBlocked ? choices : choices.filter((choice) => !choice.blocked);
  }

  function normalizedTrackName(value) {
    return compact(value)
      .toLowerCase()
      .replace(/ё/g, "е")
      .replace(/[^a-zа-я0-9]+/gi, " ")
      .trim();
  }

  function mediaLanguageFamily(...values) {
    const aliases = {
      ru: "ru", rus: "ru", russian: "ru",
      en: "en", eng: "en", english: "en",
      uk: "uk", ukr: "uk", ukrainian: "uk",
      es: "es", spa: "es", spanish: "es",
      fr: "fr", fra: "fr", fre: "fr", french: "fr",
      de: "de", deu: "de", ger: "de", german: "de",
      it: "it", ita: "it", italian: "it",
      pt: "pt", por: "pt", portuguese: "pt",
      pl: "pl", pol: "pl", polish: "pl",
      tr: "tr", tur: "tr", turkish: "tr",
      ja: "ja", jpn: "ja", japanese: "ja",
      ko: "ko", kor: "ko", korean: "ko",
      zh: "zh", zho: "zh", chi: "zh", chinese: "zh",
    };
    for (const value of values) {
      const raw = compact(value).toLowerCase().replace(/ё/g, "е");
      if (!raw) continue;
      const compactCode = raw.split(/[-_]/)[0].replace(/\d+$/, "");
      if (aliases[compactCode]) return aliases[compactCode];
      if (/(?:^|[^a-zа-я])(рус|russian|rus)(?:[^a-zа-я]|$)/i.test(raw)) return "ru";
      if (/(?:^|[^a-zа-я])(англ|english|eng)(?:[^a-zа-я]|$)/i.test(raw)) return "en";
      if (/(?:^|[^a-zа-я])(укр|ukrainian|ukr)(?:[^a-zа-я]|$)/i.test(raw)) return "uk";
      for (const [alias, family] of Object.entries(aliases)) {
        if (alias.length > 2 && new RegExp(`(?:^|[^a-z])${alias}(?:[^a-z]|$)`, "i").test(raw)) return family;
      }
    }
    return "";
  }

  function similarTrackName(left, right) {
    const a = normalizedTrackName(left);
    const b = normalizedTrackName(right);
    if (!a || !b) return false;
    if (a === b) return true;
    const joinedA = a.replace(/\s+/g, "");
    const joinedB = b.replace(/\s+/g, "");
    return Math.min(joinedA.length, joinedB.length) >= 5 &&
      (joinedA.includes(joinedB) || joinedB.includes(joinedA));
  }

  function cleanAudioPreference(value) {
    if (!value) return null;
    if (typeof value === "string") {
      const tag = compact(value).slice(0, 120);
      return tag ? { tag, name: "", language: mediaLanguageFamily(tag) } : null;
    }
    if (typeof value !== "object") return null;
    const tag = compact(value.tag || value.audioLang || "").slice(0, 120);
    const name = compact(value.name || value.audioName || "").slice(0, 120);
    const language = mediaLanguageFamily(value.language, tag, name);
    if (!tag && !name && !language) return null;
    return { tag, name, language };
  }

  function audioPreferenceForChoice(choice) {
    if (!choice?.track) return null;
    const tag = compact(audioTag(choice.track)).slice(0, 120);
    const name = compact(choice.name || audioNameFor(choice.track, 0)).slice(0, 120);
    return cleanAudioPreference({ tag, name, language: mediaLanguageFamily(choice.track.language, tag, name) });
  }

  function chooseAudioPreference(choices, value) {
    const preference = cleanAudioPreference(value);
    const available = (Array.isArray(choices) ? choices : []).filter((choice) => choice && !choice.blocked);
    if (!available.length || !preference) return null;
    if (preference.name) {
      const exactName = available.find((choice) => normalizedTrackName(choice.name) === normalizedTrackName(preference.name));
      if (exactName) return exactName;
      const similarName = available.find((choice) => similarTrackName(choice.name, preference.name));
      if (similarName) return similarName;
    }
    if (preference.tag) {
      const exactTag = available.find((choice) => audioTag(choice.track) === preference.tag);
      if (exactTag) return exactTag;
    }
    const language = preference.language || mediaLanguageFamily(preference.tag, preference.name);
    return language
      ? available.find((choice) => mediaLanguageFamily(choice.track?.language, audioTag(choice.track), choice.name) === language) || null
      : null;
  }

  function currentAudioPreference(player = state.player) {
    if (state.audioPreference) return cleanAudioPreference(state.audioPreference);
    const active = shakaAudioChoices(player?.getVariantTracks?.() || [], true)
      .find((choice) => choice.track.active && !choice.blocked);
    return audioPreferenceForChoice(active);
  }

  function cleanSubtitlePreference(value) {
    if (!value || typeof value !== "object") return null;
    const label = compact(value.label || "").slice(0, 160);
    const language = mediaLanguageFamily(value.language, label);
    return {
      enabled: value.enabled !== false,
      requested: !!value.requested,
      label,
      language,
      offset: clampOffset(Number(value.offset) || 0),
    };
  }

  function subtitlePreferenceForTrack(track, options = {}) {
    if (!track) return null;
    const label = compact(track.label || track.language || "subs").slice(0, 160);
    return cleanSubtitlePreference({
      enabled: options.enabled !== false,
      requested: !!options.requested,
      label,
      language: mediaLanguageFamily(track.language, label),
      offset: options.offset ?? state.subtitleOffset,
    });
  }

  function chooseSubtitleTrack(tracks, value) {
    const preference = cleanSubtitlePreference(value);
    const available = Array.isArray(tracks) ? tracks : [];
    if (!preference?.enabled || !available.length) return null;
    if (preference.label) {
      const exact = available.find((track) => normalizedTrackName(track.label || track.language) === normalizedTrackName(preference.label));
      if (exact) return exact;
      const similar = available.find((track) => similarTrackName(track.label || track.language, preference.label));
      if (similar) return similar;
    }
    const language = preference.language || mediaLanguageFamily(preference.label);
    return language
      ? available.find((track) => mediaLanguageFamily(track.language, track.label) === language) || null
      : null;
  }

  function loadedSubtitleTrack(track) {
    return (state.loadedSubs || []).some((item) =>
      (item.trackId != null && item.trackId === track?.id) ||
      (item.label === track?.label && item.language === track?.language));
  }

  function currentSubtitlePreference(player = state.player) {
    if (state.subtitlePreference) return cleanSubtitlePreference(state.subtitlePreference);
    if (!player?.isTextTrackVisible?.()) return cleanSubtitlePreference({ enabled: false });
    const active = (player.getTextTracks?.() || []).find((track) => track.active);
    return subtitlePreferenceForTrack(active, { requested: loadedSubtitleTrack(active) });
  }
  function bitrateLabel(track) {
    return track.bandwidth ? `${(track.bandwidth / 1000000).toFixed(1)} Mbps` : "";
  }
  // Name a rung by frame WIDTH. A 2.40:1 master is stored as 1920x800 with the
  // letterbox rows simply absent, so reading the height called a full-width
  // 1080p source "800p" — and an IMAX 1938x1020 one "1020p", which sorts below a
  // narrower 1920x1080 despite being wider. Width is what actually tracks the
  // master here, and it is what every mainstream player labels by.
  const QUALITY_WIDTH_STEPS = [
    [3600, "4K"], [2500, "1440p"], [1900, "1080p"], [1260, "720p"],
    [830, "480p"], [620, "360p"], [1, "240p"],
  ];
  function qualityLabel(track) {
    const width = Number(track?.width) || 0;
    if (width) return QUALITY_WIDTH_STEPS.find(([min]) => width >= min)?.[1] || "";
    // Some providers expose only a height; fall back rather than lose the rung.
    return track?.height ? `${track.height}p` : "";
  }
  function groupBy(list, keyFn) {
    const map = new Map();
    for (const item of list) {
      const key = keyFn(item);
      const current = map.get(key);
      // Shaka returns one variant per quality for each dub. Keep the active
      // representative so the button follows a switch instead of looking stuck.
      if (!current || (!current.active && item.active)) map.set(key, item);
    }
    return [...map.values()];
  }
  function decodeJsString(raw) {
    try { return Function(`"use strict"; return (${raw});`)(); }
    catch { return String(raw || "").slice(1, -1); }
  }
  function cleanUrl(value, base) {
    try { return new URL(String(value || "").replace(/&amp;/g, "&"), base).href; }
    catch { return null; }
  }
  function safeDecode(value) {
    try { return decodeURIComponent(String(value || "")); }
    catch { return String(value || ""); }
  }
  function legacyHashPath(path) {
    return `/#${path.startsWith("/") ? path : `/${path}`}`;
  }
  function shortOrtifiedPath(embedUrl) {
    try {
      const url = new URL(String(embedUrl || ""));
      const id = url.pathname.match(/^\/embed\/movie\/(\d+)/i)?.[1];
      if (!/^api\.ortified\.ws$/i.test(url.host) || !id) return "";
      const season = positiveInt(url.searchParams.get("season"));
      const episode = positiveInt(url.searchParams.get("episode"));
      return season && episode ? `/o/${id}/s${season}e${episode}` : `/o/${id}`;
    } catch {
      return "";
    }
  }
  function ortifiedUrlFromShort(id, episodeKey) {
    const url = new URL(`https://api.ortified.ws/embed/movie/${encodeURIComponent(id)}`);
    const match = String(episodeKey || "").match(/^s(\d+)e(\d+)$/i);
    if (match) {
      url.searchParams.set("season", match[1]);
      url.searchParams.set("episode", match[2]);
    }
    return url.href;
  }
  // The watch route keeps only {id, season, episode}, so playOrt always receives the
  // rebuilt clean URL. Meta handoffs must be keyed by that same form — catalog items
  // store whatever embed the admin added (including duplicated ?episode params).
  function canonicalOrtEmbedUrl(embedUrl) {
    const short = shortOrtifiedPath(embedUrl);
    if (!short) return String(embedUrl || "");
    const segs = short.split("/").filter(Boolean);
    return ortifiedUrlFromShort(segs[1], segs[2]);
  }
  function shortNewdeafPath(pageUrl) {
    try {
      const url = new URL(String(pageUrl || ""));
      if (!/(^|\.)newdeaf\.co$/i.test(url.host)) return "";
      const path = url.pathname.split("/").filter(Boolean).map(safeDecode).join("/").replace(/\.html$/i, "");
      if (!/^(film|serial|multfilm|anime|multserial|multserialy)\//i.test(path)) return "";
      return `/n/${path.split("/").map(encodeURIComponent).join("/")}`;
    } catch {
      return "";
    }
  }
  function newdeafUrlFromShortPath(parts) {
    const path = (parts || []).join("/").replace(/^\/+/, "").replace(/\.html$/i, "");
    if (!/^(film|serial|multfilm|anime|multserial|multserialy)\//i.test(path)) return "";
    const origin = dailyMirrorCandidates()[0] || "https://newdeaf.co";
    return `${origin}/${path.split("/").map(encodeURIComponent).join("/")}.html`;
  }
  function cleanBaseUrl(value) {
    return String(value || "").trim().replace(/\/+$/, "");
  }
  function extractYear(value) {
    return String(value || "").match(/\b(19|20)\d{2}\b/)?.[0] || "";
  }
  function unique(values) {
    return [...new Set(values.filter(Boolean))];
  }
  function compact(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }
  function escapeHtml(value) {
    return String(value || "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  }
  function escapeAttr(value) {
    return escapeHtml(value).replace(/`/g, "&#96;");
  }
  function log(...args) {
    if (DEBUG) console.log("[alphy]", ...args);
  }
  function showError(error) {
    const message = String(error?.message || error);
    el.error.textContent = `Ошибка: ${message}`;
    el.error.classList.remove("hidden");
    log("error", message, error?.stack);
  }
  function hideError() {
    el.error.classList.add("hidden");
  }

  // =====================================================================
  // Search input + onscreen controls
  // =====================================================================
  // =====================================================================
  // Search suggestions
  //
  // Two tiers, because one network round trip is already too slow to feel
  // instant: reaching a shard and coming back costs ~560ms before any work is
  // done, so anything server-backed can only ever be "fast", never "instant".
  //
  //  0. Local — the curated catalogue is already in memory, plus history and
  //     bookmarks. Matched in-process, 0ms, and every hit carries its target so
  //     picking one opens it with no resolve at all.
  //  1. The LiftW relay, debounced, appended underneath. The box is never empty
  //     while it waits because tier 0 has already filled it.
  //
  // PoiskKino is deliberately absent: it is the metered quota that runs out,
  // and a debounced query still fires several requests. It stays on Enter.
  // =====================================================================
  // The mirrored catalogue: 81,700 titles, one shard per first letter, fetched
  // once and then matched locally. It is served from Supabase rather than the
  // Cloudflare Worker that builds it because Workers are throttled from Russia.
  const TITLES_INDEX_URL = "https://xoathqkggcuyoyutxwri.supabase.co/functions/v1/titles";
  // Shards are read as static objects from Supabase Storage, never from the
  // function above. Cloudflare fronts Supabase Functions with
  // `cf-cache-status: DYNAMIC` — it does not cache a function response whatever
  // Cache-Control says — so every shard fetch used to re-run the function and
  // re-read Postgres: 2.25s and up to ten queries per letter, per viewer.
  // Storage objects go through the same CDN and are cached: 0.20s, brotli, and
  // the database is not touched at all.
  //
  // More than one host here turns into a ring routed by the letter, the same
  // shape as the Letterboxd and LiftW relays: a project's free egress is finite,
  // and spreading the letters across accounts multiplies it while making any one
  // project's failure a failover rather than an outage.
  const TITLES_SHARD_HOSTS = [
    "https://xoathqkggcuyoyutxwri.supabase.co/storage/v1/object/public/index",
  ];
  const TITLES_SHARD_TTL_MS = 7 * 24 * 3600e3;
  // Below this the cached copy is used without asking. Above it, it is still
  // used immediately and a conditional request refreshes it in the background.
  const TITLES_SHARD_FRESH_MS = 30 * 60e3;
  // Bumped when the shard payload changes shape or contents. Shards live in the
  // viewer's IndexedDB for a week, so without this a browser that cached a
  // Russian-only shard would keep answering English queries with nothing until
  // that week ran out.
  const TITLES_SHARD_VERSION = 3;
  // The index as published to jsDelivr (scripts/publish-search-cdn.mjs): a
  // pointer of a few hundred bytes on Supabase names a commit and an index
  // file; the index names each letter's base and delta. Every file but the
  // pointer is immutable, so a letter already in this browser is never
  // downloaded again until it is actually rebuilt. The Supabase shards above
  // remain the fallback whenever this path cannot answer.
  const SEARCH_POINTER_URL = "https://xoathqkggcuyoyutxwri.supabase.co/storage/v1/object/public/index/pointer.json";
  const SEARCH_CDN_BASE = "https://cdn.jsdelivr.net/gh/udbv4d2wayz3am6d2kwskzvtvs8q/rfb2akkdbet2am996jvrftk67ydv3sz5s2ve@";
  // The same commit through rawcdn.githack, asked only once jsDelivr has failed
  // for a file — for instance the 403 it gives a commit over 50 MB. Content-
  // addressed and commit-pinned, so either host returns the same bytes.
  const SEARCH_CDN_RESERVE = "https://rawcdn.githack.com/udbv4d2wayz3am6d2kwskzvtvs8q/rfb2akkdbet2am996jvrftk67ydv3sz5s2ve/";
  const SEARCH_CDN_FIRST_TIMEOUT_MS = 4000;
  // A long-open tab asks for a newer index at least this often while it is used.
  const SEARCH_POINTER_REFRESH_MS = 30 * 60e3;
  const SUGGEST_DEBOUNCE_MS = 260;
  const SUGGEST_MIN_REMOTE = 3;
  const SUGGEST_LOCAL_LIMIT = 6;
  const SUGGEST_REMOTE_LIMIT = 6;
  let suggestIndex = null;
  let suggestTimer = null;
  let suggestToken = 0;
  let suggestActive = -1;
  let suggestRows = [];
  // The last set of index hits, kept across keystrokes so the next character
  // narrows the list in place rather than emptying it for a quarter second.
  let suggestRemote = [];
  let suggestSignature = null;

  const suggestFold = (value) => String(value || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

  function buildSuggestIndex() {
    const out = [];
    const seen = new Set();
    const push = (entry, source) => {
      const title = String(entry?.title || "").trim();
      if (!title || !entry?.target) return;
      const key = `${suggestFold(title)}|${entry.year || ""}`;
      if (seen.has(key)) return;
      seen.add(key);
      // History keeps a metadata snapshot, so a title already watched can be
      // found by its English name too — and shows it, the same as an index row.
      const originName = String(entry?.originName || entry?.originalTitle
        || entry?.meta?.originalTitle || "").trim();
      out.push({
        title,
        year: String(entry.year || ""),
        isSeries: !!entry.isSeries,
        poster: entry.poster || "",
        target: entry.target,
        source,
        originName,
        folded: suggestFold(title),
        foldedOrigin: suggestFold(originName),
      });
    };
    // History and bookmarks first: a title the viewer already knows beats a catalogue
    // entry they have never opened, and the dedupe above keeps the first one.
    for (const entry of loadList(STORE_HISTORY).slice(0, 60)) push(entry, "history");
    for (const entry of loadList(STORE_BOOKMARKS)) push(entry, "bookmark");
    for (const entry of window.alphyCatalog?.suggestItems?.() || []) push(entry, "catalog");
    suggestIndex = out;
    return out;
  }

  function matchLocalSuggest(query) {
    const folded = suggestFold(query);
    if (!folded) return [];
    const index = suggestIndex || buildSuggestIndex();
    const scored = [];
    for (const entry of index) {
      // Rank by how early the match starts: a title that begins with what was
      // typed is what the viewer meant; a match buried mid-word rarely is —
      // "мис" finding "Программисты" reads as a bug, not as a helpful extra.
      let score = -1;
      if (entry.folded.startsWith(folded)) score = 0;
      else if (entry.folded.includes(` ${folded}`)) score = 1;
      // Same for the original title, half a step behind so it only breaks ties.
      if (entry.foldedOrigin && entry.foldedOrigin !== entry.folded) {
        let originScore = -1;
        if (entry.foldedOrigin.startsWith(folded)) originScore = 0.5;
        else if (entry.foldedOrigin.includes(` ${folded}`)) originScore = 1.5;
        if (originScore >= 0 && (score < 0 || originScore < score)) score = originScore;
      }
      if (score < 0) continue;
      if (entry.source === "history") score -= 0.3;
      else if (entry.source === "bookmark") score -= 0.2;
      scored.push({ entry, score });
    }
    scored.sort((a, b) => a.score - b.score || a.entry.title.localeCompare(b.entry.title, "ru"));
    return scored.slice(0, SUGGEST_LOCAL_LIMIT).map((item) => item.entry);
  }

  // Shards live in IndexedDB: a busy letter is ~100KB, which localStorage would
  // both refuse and evict. Held in memory too, so repeat keystrokes cost nothing.
  const shardMemory = new Map();
  let shardDb = null;

  function shardStore() {
    if (shardDb) return shardDb;
    shardDb = new Promise((resolve) => {
      let request;
      try { request = indexedDB.open("alphy-titles", 1); } catch { resolve(null); return; }
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("shards")) request.result.createObjectStore("shards");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      // `open` can fire none of the three: another tab holding an older version
      // blocks it, and a pending deleteDatabase wedges it indefinitely. Without
      // this the awaited promise never settles and search stops working
      // entirely — silently, and until the tab is closed. The cache is an
      // optimisation; losing it must cost a network fetch, not the feature.
      request.onblocked = () => resolve(null);
      setTimeout(() => resolve(null), 3000);
    });
    return shardDb;
  }

  async function readShard(letter) {
    const db = await shardStore();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const request = db.transaction("shards", "readonly").objectStore("shards").get(letter);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => resolve(null);
      } catch { resolve(null); }
    });
  }

  async function writeShard(letter, value) {
    const db = await shardStore();
    if (!db) return;
    try { db.transaction("shards", "readwrite").objectStore("shards").put(value, letter); }
    catch { /* a full or unavailable store must not break search */ }
  }

  const shardInMemory = (rawLetter) =>
    shardMemory.get(`${rawLetter}:${TITLES_SHARD_VERSION}`) || null;

  // An object is named by the letter's codepoint, so the path is plain ASCII
  // whatever the alphabet — the index holds 86 distinct initials, Cyrillic and
  // Latin and CJK, and several of them are not URL-safe.
  const shardObject = (letter) =>
    `v${TITLES_SHARD_VERSION}/${letter.codePointAt(0).toString(16)}.json`;

  // A letter always starts at the same host, so its CDN entry is worth having,
  // and letters spread evenly. The rest of the ring is failover.
  const shardHostOrder = (letter) => {
    const start = letter.codePointAt(0) % TITLES_SHARD_HOSTS.length;
    return TITLES_SHARD_HOSTS.map((_, i) =>
      TITLES_SHARD_HOSTS[(start + i) % TITLES_SHARD_HOSTS.length]);
  };

  async function fetchShard(rawLetter, etag = "") {
    for (const host of shardHostOrder(rawLetter)) {
      try {
        const response = await fetchWithTimeout(`${host}/${shardObject(rawLetter)}`,
          etag ? { headers: { "If-None-Match": etag } } : {}, 12000);
        // Unchanged since the copy we hold. Storage answers this in ~0.2s with
        // no body at all, which is what makes revalidating cheap enough to do
        // on every session.
        if (response.status === 304) return { rows: null, etag };
        // A missing object answers 400 with a NoSuchKey body, not 404, so only
        // a real payload counts as an answer.
        if (response.ok) {
          const rows = await response.json();
          if (Array.isArray(rows)) return { rows, etag: response.headers.get("ETag") || "" };
        }
      } catch { /* try the next mirror */ }
    }
    // The function builds a shard live. Only reached for a letter that has never
    // been built — a brand new initial — so it is correct but slow, by design.
    const response = await fetchWithTimeout(
      `${TITLES_INDEX_URL}?i=${encodeURIComponent(rawLetter)}&v=${TITLES_SHARD_VERSION}`, {}, 15000,
    );
    if (!response.ok) throw new Error(`index ${response.status}`);
    return { rows: await response.json(), etag: "" };
  }

  // In flight, by letter. The debounce only cancels a timer that has not fired
  // yet: once a load starts, the next keystroke schedules another 260ms later,
  // and a cold shard takes longer than that on anything but a fast connection.
  // Measured with 2s of latency, one letter was fetched three times in
  // parallel — 2.3MB down the wire for a 776KB object. The token guard keeps a
  // stale answer off the screen; it does nothing about the duplicate request.
  const shardInFlight = new Map();

  // Refresh a cached shard in the background. Nothing waits on it: the rows
  // already returned are what this keystroke uses, and the next one picks up
  // whatever landed. A failure leaves the cached copy exactly as it was.
  function revalidateShard(rawLetter, letter, etag) {
    if (shardInFlight.has(`~${letter}`)) return;
    const done = fetchShard(rawLetter, etag)
      .then(({ rows, etag: fresh }) => {
        // 304: still current, so only the timestamp moves — otherwise every
        // session after the first would revalidate again.
        const kept = rows || shardMemory.get(letter);
        if (!kept) return;
        if (rows) shardMemory.set(letter, rows);
        writeShard(letter, { at: Date.now(), rows: kept, etag: fresh || etag });
      })
      .catch(() => { /* the cached copy stands */ })
      .finally(() => shardInFlight.delete(`~${letter}`));
    shardInFlight.set(`~${letter}`, done);
  }

  let searchPointer = null;
  try {
    const saved = JSON.parse(localStorage.getItem("alphy.search.pointer.v1") || "null");
    if (/^[0-9a-f]{40}$/.test(saved?.c || "") && /^i\/[0-9a-f]{16}\.json$/.test(saved?.f || "")
        && Date.now() - saved.checkedAt < 7 * 86400e3) searchPointer = saved;
  } catch { /* private storage */ }
  let searchPointerLoad = null;
  let searchPointerFailedAt = 0;
  let searchIndex = null;
  const cdnFileMemory = new Map();
  // Which index file each letter in memory was built from, so a letter is swapped
  // for its newer version once the pointer moves.
  const shardMemoryKey = new Map();

  async function cdnJson(url, timeoutMs) {
    const response = await fetchWithTimeout(url, { credentials: "omit", referrerPolicy: "no-referrer" }, timeoutMs);
    if (!response.ok) throw new Error(`${response.status}`);
    return response.json();
  }

  function currentSearchPointer({ force = false } = {}) {
    if (!force && searchPointer) {
      if (Date.now() - searchPointer.checkedAt >= SEARCH_POINTER_REFRESH_MS) currentSearchPointer({ force: true });
      return Promise.resolve(searchPointer);
    }
    // Never reached it yet and it just failed: the fallback serves meanwhile.
    if (!force && !searchPointer && Date.now() - searchPointerFailedAt < 60e3) return Promise.resolve(null);
    if (searchPointerLoad) return searchPointerLoad;
    searchPointerLoad = (async () => {
      try {
        const value = await cdnJson(SEARCH_POINTER_URL, 6000);
        if (/^[0-9a-f]{40}$/.test(String(value?.c)) && /^i\/[0-9a-f]{16}\.json$/.test(String(value?.f))) {
          searchPointer = { c: value.c, f: value.f, checkedAt: Date.now() };
          try { localStorage.setItem("alphy.search.pointer.v1", JSON.stringify(searchPointer)); } catch { /* optional */ }
        } else if (searchPointer) {
          searchPointer.checkedAt = Date.now();
        }
      } catch {
        // Unreachable: keep what we have and try again in a minute, not in half an hour.
        searchPointerFailedAt = Date.now();
        if (searchPointer) searchPointer.checkedAt = Date.now() - SEARCH_POINTER_REFRESH_MS + 60e3;
      }
      return searchPointer;
    })().finally(() => { searchPointerLoad = null; });
    return searchPointerLoad;
  }

  // Content-addressed, so the name alone identifies the bytes: whatever this
  // browser already holds under a name is current by definition.
  async function immutableCdnFile(commit, file, timeoutMs) {
    const key = `cdn:${file}`;
    if (cdnFileMemory.has(key)) return cdnFileMemory.get(key);
    const stored = await readShard(key);
    if (stored && stored.value !== undefined) {
      cdnFileMemory.set(key, stored.value);
      return stored.value;
    }
    let value;
    try {
      // Headers from a warmed jsDelivr file take well under a second; waiting the
      // whole budget for them would only delay the reserve.
      value = await cdnJson(`${SEARCH_CDN_BASE}${commit}/${file}`, Math.min(timeoutMs, SEARCH_CDN_FIRST_TIMEOUT_MS));
    } catch (error) {
      log("search-cdn-reserve", { file, message: error.message });
      value = await cdnJson(`${SEARCH_CDN_RESERVE}${commit}/${file}`, timeoutMs);
    }
    cdnFileMemory.set(key, value);
    writeShard(key, { at: Date.now(), value });
    return value;
  }

  async function currentSearchIndex() {
    const pointer = await currentSearchPointer();
    if (!pointer) return null;
    if (searchIndex?.file === pointer.f) return searchIndex;
    const value = await immutableCdnFile(pointer.c, pointer.f, 8000);
    if (value?.v !== 1 || !value.l || typeof value.l !== "object") throw new Error("bad search index");
    searchIndex = { file: pointer.f, commit: pointer.c, l: value.l };
    pruneCdnFiles(searchIndex);
    return searchIndex;
  }

  // A delta lists the rows to put in place — one per title, found by slug — and
  // the titles that left the letter. Every other row of the base stands.
  function applySearchDelta(base, delta) {
    const upserts = Array.isArray(delta?.u) ? delta.u : [];
    const removes = Array.isArray(delta?.r) ? delta.r : [];
    if (!upserts.length && !removes.length) return base;
    const replaced = new Set([...removes, ...upserts.map((row) => row[2])]);
    return base.filter((row) => !replaced.has(row[2])).concat(upserts);
  }

  const cdnEntryKey = (entry) => (Array.isArray(entry) ? `${entry[0]}|${entry[3] || ""}` : "");

  async function loadCdnLetter(rawLetter) {
    const index = await currentSearchIndex();
    const entry = index?.l?.[rawLetter.codePointAt(0).toString(16)];
    if (!Array.isArray(entry)) return null;
    const [baseFile, baseCommit, , deltaFile, deltaCommit] = entry;
    const [base, delta] = await Promise.all([
      immutableCdnFile(baseCommit, baseFile, 12000),
      deltaFile ? immutableCdnFile(deltaCommit, deltaFile, 8000) : null,
    ]);
    if (!Array.isArray(base)) throw new Error("bad search base");
    return { key: cdnEntryKey(entry), rows: applySearchDelta(base, delta) };
  }

  // A part is cut from its letter's base when the base is rebuilt, so the
  // letter's delta goes on top: every upsert and removal takes its slug out, and
  // only the upserts with a word under this prefix come back in — the same rule
  // the publisher files a row by.
  function applyPrefixDelta(part, delta, prefix) {
    const upserts = Array.isArray(delta?.u) ? delta.u : [];
    const removes = Array.isArray(delta?.r) ? delta.r : [];
    if (!upserts.length && !removes.length) return part;
    const replaced = new Set([...removes, ...upserts.map((row) => row[2])]);
    const filed = (row) => [row[0], row[6]].some((value) => suggestFold(value).split(" ")
      .some((word) => [...word].length >= 3 && [...word].slice(0, 3).join("") === prefix));
    return part.filter((row) => !replaced.has(row[2])).concat(upserts.filter(filed));
  }

  const prefixRows = new Map();
  const prefixLoads = new Map();
  async function loadSearchRows(query) {
    const folded = suggestFold(query);
    const firstWord = folded.split(" ")[0];
    const letter = [...folded][0];
    if (!letter) return [];
    if ([...firstWord].length < 3) return loadShard(letter);
    try {
      const index = await currentSearchIndex();
      const entry = index?.l?.[letter.codePointAt(0).toString(16)];
      if (!entry?.[5]) return loadShard(letter);
      const prefix = [...firstWord].slice(0, 3).join("");
      const key = `${index.file}:${prefix}`;
      if (prefixLoads.has(key)) return prefixLoads.get(key);
      const pending = (async () => {
        const manifest = await immutableCdnFile(index.commit, entry[5], 5000);
        const part = manifest[prefix];
        const [partRows, delta] = await Promise.all([
          part ? immutableCdnFile(part[1], part[0], 8000) : [],
          entry[3] ? immutableCdnFile(entry[4], entry[3], 8000) : null,
        ]);
        if (!Array.isArray(partRows)) throw new Error("bad prefix shard");
        const rows = applyPrefixDelta(partRows, delta, prefix);
        prefixRows.set(prefix, rows);
        if (prefixRows.size > 32) prefixRows.delete(prefixRows.keys().next().value);
        return rows;
      })().finally(() => prefixLoads.delete(key));
      prefixLoads.set(key, pending);
      return await pending;
    } catch { return loadShard(letter); }
  }

  // Files the current index no longer names are dropped from IndexedDB, or a
  // year of hourly deltas would pile up in it.
  function pruneCdnFiles(index) {
    const keep = new Set([`cdn:${index.file}`]);
    for (const entry of Object.values(index.l)) {
      if (!Array.isArray(entry)) continue;
      keep.add(`cdn:${entry[0]}`);
      if (entry[3]) keep.add(`cdn:${entry[3]}`);
      if (entry[5]) keep.add(`cdn:${entry[5]}`);
    }
    for (const key of cdnFileMemory.keys()) if (!keep.has(key) && !key.startsWith("cdn:p/")) cdnFileMemory.delete(key);
    while (cdnFileMemory.size > 96) cdnFileMemory.delete(cdnFileMemory.keys().next().value);
    shardStore().then((db) => {
      if (!db) return;
      try {
        const store = db.transaction("shards", "readwrite").objectStore("shards");
        const request = store.getAllKeys();
        request.onsuccess = () => {
          for (const key of request.result || []) {
            if (String(key).startsWith("cdn:") && !keep.has(key) && !String(key).startsWith("cdn:p/")) store.delete(key);
            if (String(key).startsWith("cdn:p/")) {
              const read = store.get(key);
              read.onsuccess = () => { if (Date.now() - Number(read.result?.at || 0) > 7 * 86400e3) store.delete(key); };
            }
          }
        };
      } catch { /* housekeeping only */ }
    });
  }

  // A letter held in memory is served at once; if the index has moved since it
  // was built, the newer version replaces it for the next keystroke.
  function refreshCdnLetter(rawLetter, letter) {
    if (!shardMemoryKey.has(letter) || shardInFlight.has(`^${letter}`)) return;
    const refresh = (async () => {
      const index = await currentSearchIndex();
      const entry = index?.l?.[rawLetter.codePointAt(0).toString(16)];
      if (!entry || cdnEntryKey(entry) === shardMemoryKey.get(letter)) return;
      const cdn = await loadCdnLetter(rawLetter);
      if (!cdn) return;
      shardMemory.set(letter, cdn.rows);
      shardMemoryKey.set(letter, cdn.key);
    })().catch(() => { /* the rows in memory stand */ })
      .finally(() => shardInFlight.delete(`^${letter}`));
    shardInFlight.set(`^${letter}`, refresh);
  }

  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible" || !searchPointer) return;
      if (Date.now() - searchPointer.checkedAt >= SEARCH_POINTER_REFRESH_MS) currentSearchPointer({ force: true });
    });
  }

  function loadShard(rawLetter) {
    const letter = `${rawLetter}:${TITLES_SHARD_VERSION}`;
    if (shardMemory.has(letter)) {
      refreshCdnLetter(rawLetter, letter);
      return Promise.resolve(shardMemory.get(letter));
    }
    const pending = shardInFlight.get(letter);
    if (pending) return pending;
    const load = (async () => {
      try {
        const cdn = await loadCdnLetter(rawLetter);
        if (cdn) {
          shardMemory.set(letter, cdn.rows);
          shardMemoryKey.set(letter, cdn.key);
          return cdn.rows;
        }
      } catch (error) {
        log("search-cdn-warn", { letter: rawLetter, message: error.message });
      }
      const cached = await readShard(letter);
      if (cached && Date.now() - cached.at < TITLES_SHARD_TTL_MS) {
        shardMemory.set(letter, cached.rows);
        // Served straight from the cache, then refreshed behind the viewer's
        // back. Storage objects come back `no-cache` whatever we upload them
        // with, so the CDN already revalidates and a rebuilt shard is visible
        // there at once — but this copy is the viewer's own and had nothing
        // checking it for a week. A title resolved on Monday was not findable
        // by its original name until the following Monday.
        if (Date.now() - cached.at > TITLES_SHARD_FRESH_MS) {
          revalidateShard(rawLetter, letter, cached.etag || "");
        }
        return cached.rows;
      }
      const { rows, etag } = await fetchShard(rawLetter);
      shardMemory.set(letter, rows);
      writeShard(letter, { at: Date.now(), rows, etag });
      return rows;
    })();
    shardInFlight.set(letter, load);
    // Cleared either way: a failed load must not pin the letter to a rejected
    // promise for the rest of the session.
    return load.finally(() => shardInFlight.delete(letter));
  }

  // [name, year, slug, isSeries, embed_id, kp, originName] — deliberately
  // positional: at 81,700 rows the key names would be most of the payload.

  // Exact first, then start-of-title, then start-of-word. A match buried
  // mid-word is almost never what was meant.
  const suggestScore = (folded, candidate) => {
    if (!candidate) return -1;
    if (candidate === folded) return 0;
    if (candidate.startsWith(folded)) return 1;
    if (candidate.includes(` ${folded}`)) return 2;
    return -1;
  };

  function matchShard(rows, query, limit = SUGGEST_REMOTE_LIMIT) {
    const folded = suggestFold(query);
    if (!folded) return [];
    const out = [];
    for (const row of rows) {
      const name = suggestFold(row[0]);
      // Ordering purely by recency put «Брат 3» (2022) above «Брат» (1997) and
      // pushed the film actually being searched for off the list entirely — for
      // a short, famous title that reads as broken.
      let score = suggestScore(folded, name);
      // The original title is searched as well, or the shard would carry English
      // names it could never match: someone typing "Good Will Hunting" gets
      // «Умница Уилл Хантинг», which is the whole point of mirroring both. Half
      // a step behind an equally good Russian match, so the two orderings only
      // ever break a tie rather than reshuffle the list.
      const origin = row[6] ? suggestFold(row[6]) : "";
      if (origin && origin !== name) {
        const originScore = suggestScore(folded, origin);
        if (originScore >= 0 && (score < 0 || originScore + 0.5 < score)) score = originScore + 0.5;
      }
      if (score < 0) continue;
      out.push({ score, entry: {
        title: row[0], year: String(row[1] || ""), slug: row[2],
        isSeries: !!row[3], poster: "", liftId: row[4] || null, kpId: row[5] || "",
        originName: row[6] || "", source: "index", folded: name,
      } });
      // No cap here. Stopping at the first 400 candidates decided them by the
      // order the shard happens to be in — year descending — so an exact match
      // older than four hundred newer partial ones could never reach the sort
      // below. «при» already has 1,168 candidates in one shard. It costs
      // nothing to keep them all: the loop walks the whole shard either way,
      // and sorting a thousand entries is well under a millisecond.
    }
    // `a || b ? 1 : -1` parses as `(a || b) ? 1 : -1`, so the score was collapsed
    // to a bare truthiness test and the year never compared at all — the list
    // came out in near-random order. Comparator arms must return numbers.
    // The title last: a letter built from a base plus a delta holds its rows in a
    // different order than a freshly rebuilt one, and equal score and year must
    // not let that order decide which six are shown.
    out.sort((a, b) => (a.score - b.score) || ((Number(b.entry.year) || 0) - (Number(a.entry.year) || 0))
      || a.entry.title.localeCompare(b.entry.title, "ru"));
    return out.slice(0, limit).map((item) => item.entry);
  }

  function suggestRow(entry) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `suggest-row suggest-${entry.source}`;
    const title = document.createElement("span");
    title.className = "suggest-title";
    title.textContent = entry.title;
    // No фильм/сериал label: the catalogue's type codes do not actually separate
    // them — 1 and 2 are films, 3, 4 and 5 all carry seasons — so half of them
    // were wrong, and a wrong label is worse than none.
    const year = document.createElement("span");
    year.className = "suggest-year";
    year.textContent = entry.year || "";
    row.append(title, year);
    // The original title, where the backfill has reached it. Same weight as the
    // year: it disambiguates without competing with the name.
    if (entry.originName && suggestFold(entry.originName) !== suggestFold(entry.title)) {
      const origin = document.createElement("span");
      origin.className = "suggest-origin";
      origin.textContent = entry.originName;
      row.appendChild(origin);
    }
    bindSuggestActivation(row, () => chooseSuggest(entry));
    const warm = () => {
      const id = entry.liftId || (entry.target?.kind === "lift" ? entry.target.liftId : null);
      if (id) prefetchLiftwTitle(id);
    };
    row.addEventListener("pointerenter", warm, { passive: true });
    row.addEventListener("focus", warm);
    row.addEventListener("pointerdown", warm, { passive: true });
    return row;
  }

  function bindSuggestActivation(row, choose) {
    let down = null, chosen = false, cancelledPointer = false;
    const activate = () => { if (!chosen) { chosen = true; choose(); } };
    row.addEventListener("pointerdown", (event) => {
      if (event.isPrimary === false || event.button > 0) return;
      // Keep the input focused until pointerup; iOS may otherwise remove the
      // blurred suggestion before its synthesized mouse/click events arrive.
      event.preventDefault();
      cancelledPointer = false;
      down = { id: event.pointerId, x: event.clientX, y: event.clientY };
    });
    row.addEventListener("pointerup", (event) => {
      if (!down || down.id !== event.pointerId) return;
      const moved = Math.hypot(event.clientX - down.x, event.clientY - down.y);
      down = null;
      cancelledPointer = moved > 12;
      if (!cancelledPointer) { event.preventDefault(); activate(); }
    });
    row.addEventListener("pointercancel", () => { down = null; cancelledPointer = true; });
    row.addEventListener("mousedown", (event) => {
      if (!window.PointerEvent && event.button === 0) { event.preventDefault(); activate(); }
    });
    // Keyboard/assistive activation and legacy browsers retain normal buttons.
    row.addEventListener("click", (event) => {
      event.preventDefault();
      if (!cancelledPointer || event.detail === 0) activate();
    });
  }

  function chooseSuggest(entry) {
    closeSuggest();
    el.searchInput.value = entry.title;
    if (entry.source === "index") {
      openIndexSuggestion(entry);
      return;
    }
    if (entry.target) {
      // A local hit already knows where it lives, so it opens with no resolve.
      openCuratedItem({
        title: entry.title, year: entry.year, poster: entry.poster,
        isSeries: entry.isSeries, target: entry.target,
      });
      return;
    }
    onSearchSubmit();
  }

  // The index knows the player id for a title the backfill has reached, and only
  // a slug otherwise. The slug is resolved server-side because the catalogue host
  // does not resolve from Russia at all.
  async function openIndexSuggestion(entry) {
    let liftId = entry.liftId;
    let kpId = entry.kpId || "", isSeries = entry.isSeries;
    if (!liftId) {
      showPlayerLoading();
      try {
        const response = await fetchWithTimeout(
          `${TITLES_INDEX_URL}/resolve?slug=${encodeURIComponent(entry.slug)}`, {}, 15000,
        );
        const payload = await response.json();
        liftId = payload?.embed_id || null;
        kpId = validHistoryKpId(payload?.kp, kpId);
        if (typeof payload?.is_series === "boolean") isSeries = payload.is_series;
        if (!liftId) throw new Error(payload?.error || "нет плеера");
      } catch (error) {
        showError(new Error(`Не удалось открыть: ${error.message}`));
        return;
      }
    }
    const target = liftwTarget(liftId);
    if (kpId) target.kpId = kpId;
    openCuratedItem({
      title: entry.title, year: entry.year, poster: "",
      isSeries, kpId, target,
    });
  }

  const suggestKey = (entry) => `${entry.source}|${suggestFold(entry.title)}|${entry.year}`;

  function renderSuggest(local, remote) {
    const host = el.searchSuggest;
    if (!host) return;
    // Rebuilding an identical list is what made the dropdown blink on every
    // keystroke: the rows were torn down and recreated even when they were the
    // same rows. Same list, same DOM — and the highlighted row survives.
    const signature = [...local, ...remote].map(suggestKey).join("\n");
    if (signature === suggestSignature && host.firstChild) return;
    suggestSignature = signature;
    suggestRows = [];
    const frag = document.createDocumentFragment();
    for (const entry of local) {
      const row = suggestRow(entry);
      suggestRows.push({ entry, row });
      frag.appendChild(row);
    }
    if (remote.length) {
      // A heavier line, not a caption: the two groups differ in where they came
      // from, which the viewer neither knows nor needs to.
      if (local.length) {
        const rule = document.createElement("div");
        rule.className = "suggest-rule";
        frag.appendChild(rule);
      }
      for (const entry of remote) {
        const row = suggestRow(entry);
        suggestRows.push({ entry, row });
        frag.appendChild(row);
      }
    }
    host.replaceChildren(frag);
    suggestActive = -1;
    host.classList.toggle("hidden", !suggestRows.length);
  }

  function closeSuggest() {
    clearTimeout(suggestTimer);
    suggestToken += 1;
    suggestActive = -1;
    suggestRows = [];
    suggestRemote = [];
    suggestSignature = null;
    el.searchSuggest?.replaceChildren();
    el.searchSuggest?.classList.add("hidden");
  }

  function moveSuggest(delta) {
    if (!suggestRows.length) return false;
    suggestActive = (suggestActive + delta + suggestRows.length) % suggestRows.length;
    suggestRows.forEach(({ row }, index) => row.classList.toggle("active", index === suggestActive));
    suggestRows[suggestActive].row.scrollIntoView({ block: "nearest" });
    return true;
  }

  // A local hit and an index hit for the same film are the same film.
  const withoutLocal = (remote, local) => {
    const seen = new Set(local.map((entry) => `${suggestFold(entry.title)}|${entry.year}`));
    return remote.filter((entry) => !seen.has(`${suggestFold(entry.title)}|${entry.year}`));
  };

  // What the rows already on screen still match, now that another character has
  // been typed. Cheap — they are at most six — and it turns the wait for a cold
  // shard into the list narrowing rather than the list vanishing.
  const stillMatching = (entries, query) => {
    const folded = suggestFold(query);
    return entries.filter((entry) => suggestScore(folded, entry.folded) >= 0
      || suggestScore(folded, suggestFold(entry.originName)) >= 0);
  };

  function onSuggestInput() {
    const query = el.searchInput.value.trim();
    clearTimeout(suggestTimer);
    const token = ++suggestToken;
    if (query.length < 1 || /^https?:\/\//i.test(query)) {
      closeSuggest();
      return;
    }
    const local = matchLocalSuggest(query);
    if (query.length < SUGGEST_MIN_REMOTE) {
      suggestRemote = [];
      renderSuggest(local, suggestRemote);
      return;
    }
    // The shard for this letter is usually already in memory by the second
    // keystroke, and then there is nothing to wait for: matching it here means
    // the list simply changes, with no empty frame in between and no timer.
    const prefix = [...suggestFold(query).split(" ")[0]].slice(0, 3).join("");
    const warm = prefixRows.get(prefix) || shardInMemory(suggestFold(query)[0]);
    if (warm) {
      suggestRemote = withoutLocal(matchShard(warm, query), local);
      renderSuggest(local, suggestRemote);
      if (prefixRows.has(prefix)) loadSearchRows(query).catch(() => {});
      return;
    }
    // Cold shard: keep showing what is still right rather than blanking the
    // list for the length of the debounce.
    suggestRemote = stillMatching(suggestRemote, query);
    renderSuggest(local, suggestRemote);
    suggestTimer = setTimeout(() => {
      loadSearchRows(query)
        .then((rows) => {
          if (token !== suggestToken || el.searchInput.value.trim() !== query) return;
          suggestRemote = withoutLocal(matchShard(rows, query), local);
          renderSuggest(local, suggestRemote);
        })
        .catch((error) => log("suggest-index-warn", error.message));
    }, SUGGEST_DEBOUNCE_MS);
  }

  function onSearchSubmit() {
    const value = el.searchInput.value.trim();
    if (!value) return;
    if (/^https?:\/\//i.test(value)) {
      try {
        const url = new URL(value);
        if (/api\.ortified\.ws$/i.test(url.host)) return go(`/watch/ort/${encodeURIComponent(value)}`);
        if (/api\.zenithjs\.ws$/i.test(url.host)) {
          const id = value.match(/\/movie\/(\d+)/)?.[1];
          if (id) return go(`/watch/zen/${id}`);
        }
        if (/^(?:gencit\.info|opravar\.online)$/i.test(url.host) && /^\/bil\/\d+/i.test(url.pathname)) {
          return go(`/watch/opr/${encodeURIComponent(value)}`);
        }
        if (/newdeaf\.co$/i.test(url.host)) return go(`/watch/nd/${encodeURIComponent(value)}`);
        if (/^plapi\.cdnvideohub\.com$/i.test(url.host) && /\/playlist$/i.test(url.pathname)) {
          const id = url.searchParams.get("id");
          if (/^\d+$/.test(id || "")) return go(`/c/${id}`);
        }
      } catch { /* fall through to title search */ }
    }
    go(`/search/${encodeURIComponent(value)}`);
  }

  function bindKeyboard() {
    document.addEventListener("keydown", (e) => {
      if (document.activeElement === el.searchInput) return;
      if (el.watchView.classList.contains("hidden")) return;
      const v = state.videoEl;
      if (!v) return; // shortcuts only for the Shaka <video>, not the Ortified iframe
      const code = e.code;
      if (code === "ArrowRight") { e.preventDefault(); v.currentTime += 10; }
      else if (code === "ArrowLeft") { e.preventDefault(); v.currentTime -= 10; }
      else if (code === "ArrowUp") { e.preventDefault(); v.volume = Math.min(1, v.volume + 0.05); }
      else if (code === "ArrowDown") { e.preventDefault(); v.volume = Math.max(0, v.volume - 0.05); }
      else if (code === "Space" || code === "KeyK") { e.preventDefault(); v.paused ? v.play() : v.pause(); }
      else if (code === "KeyF") { e.preventDefault(); toggleFullscreen(); }
    });
  }

  // Fullscreen goes on the player host, never on a <video>. Collaps refreshes
  // its session every few minutes by swapping to a second, pre-buffered video
  // element; with fullscreen bound to the old element the browser stayed
  // formally fullscreen on a hidden, paused video, so the picture vanished and
  // playback looked stuck. The host survives every swap, so the swap becomes
  // invisible — which is the only acceptable behaviour for something the viewer
  // never asked for.
  function fullscreenTarget() {
    return el.playerHost || activeVideoEl();
  }

  function toggleFullscreen() {
    const host = fullscreenTarget();
    if (document.fullscreenElement) {
      document.exitFullscreen?.();
      return;
    }
    if (host?.requestFullscreen) {
      host.requestFullscreen().catch((error) => log("fullscreen-warn", error.message));
      return;
    }
    // iOS Safari has no Element.requestFullscreen — only the video itself can
    // go fullscreen there, and it owns the swap because it renders natively.
    const video = activeVideoEl();
    video?.webkitEnterFullscreen?.();
  }

  function activeVideoEl() {
    return state.collaps ? activeCollapsVideo() : state.videoEl;
  }

  // The <video> carries native controls, so its own fullscreen button is how
  // most viewers go fullscreen — and that makes the element itself fullscreen,
  // which is exactly what the session swap then breaks. Migrate to the host as
  // soon as it happens: while the document is already fullscreen, moving it to
  // another element needs no fresh user gesture.
  function armFullscreenGuard() {
    document.addEventListener("fullscreenchange", () => {
      const c = state.collaps;
      if (!c) return;
      const video = activeCollapsVideo();
      c.nativeFullscreenVideo = document.fullscreenElement === video ? video : null;
      if (!c.nativeFullscreenVideo) resumePendingCollapsRefresh();
    });
  }

  function currentCuratedItem() {
    const current = state.currentTarget;
    const meta = state.currentMeta || {};
    if (!state.playerReady || !current) return null;
    let target = cleanTarget(current);
    const zenithId = state.zenithEmbedUrl.match(/\/movie\/(\d+)/i)?.[1];
    if (zenithId) target = { kind: "zen", zenithId };
    const title = meta.title || movieTitle(meta) || current.title || "";
    if (!title) return null;
    return {
      id: crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
      key: keyFor(target),
      title,
      year: meta.year || current.year || "",
      poster: meta.poster || current.poster || "",
      backdrop: typeof meta.backdrop === "string" ? meta.backdrop : meta.backdrop?.url || "",
      description: meta.description || meta.shortDescription || "",
      isSeries: meta.isSeries ?? current.isSeries ?? !!state.serial,
      movieLength: meta.movieLength || null,
      rating: {
        ...(meta.rating || {}),
      },
      kpId: meta.kpId || current.kpId || "",
      externalId: {
        ...(meta.externalId || meta.externalIds || {}),
      },
      ageRating:
        meta.ageRating !== null && meta.ageRating !== undefined && meta.ageRating !== "" &&
        Number.isFinite(Number(meta.ageRating))
          ? Number(meta.ageRating)
          : null,
      ratingMpaa: meta.ratingMpaa || "",
      genres: Array.isArray(meta.genres) ? meta.genres : [],
      countries: Array.isArray(meta.countries) ? meta.countries : [],
      directors: Array.isArray(meta.directors) ? meta.directors : [],
      cast: Array.isArray(meta.cast) ? meta.cast : [],
      people: {
        directors: personRefList(meta.people?.directors, 3),
        cast: personRefList(meta.people?.cast, 8),
      },
      target,
      cachedAt: new Date().toISOString(),
    };
  }

  function openCuratedItem(item) {
    const target = item?.target;
    if (!target?.kind) return;
    const meta = {
      title: item.title,
      year: item.year,
      poster: item.poster,
      backdrop: item.backdrop,
      description: item.description,
      isSeries: item.isSeries,
      movieLength: item.movieLength,
      rating: item.rating,
      kpId: item.kpId,
      externalId: item.externalId,
      // Whatever the curator stored is served straight from the snapshot, so a
      // listed title opens with full metadata and zero API calls.
      ageRating: item.ageRating,
      ratingMpaa: item.ratingMpaa,
      genres: item.genres,
      countries: item.countries,
      directors: item.directors,
      cast: item.cast,
      people: item.people,
    };
    cacheSet("curatedmeta", keyFor(target), meta, TTL.enriched);
    if (target.kind === "ort") cacheSet("ortmeta", canonicalOrtEmbedUrl(target.embedUrl), meta, TTL.enriched);
    if (target.kind === "opr") {
      cacheSet("oprmeta", target.playerUrl, { ...meta, pageUrl: target.pageUrl || "" }, TTL.enriched);
    }
    if (target.kind === "kp") cacheMovieMetadata(target.kpId, { ...meta, kpId: target.kpId }, TTL.enriched);
    if (target.kind === "clps") cacheMovieMetadata(target.kpId, { ...meta, kpId: target.kpId }, TTL.enriched);
    if (target.kind === "rezka" && target.kpId) {
      cacheMovieMetadata(target.kpId, { ...meta, kpId: target.kpId }, TTL.enriched);
    }
    go(hashFor(target));
  }

  // =====================================================================
  // resolver settings
  // =====================================================================
  function saveResolver() {
    state.resolverBaseUrl = cleanBaseUrl(el.resolverInput.value);
    if (state.resolverBaseUrl) localStorage.setItem(STORE_RESOLVER, state.resolverBaseUrl);
    else localStorage.removeItem(STORE_RESOLVER);
    el.resolverState.textContent = state.resolverBaseUrl ? "сохранён" : "—";
  }
  async function testResolver() {
    saveResolver();
    try {
      const data = await resolverJson("/health");
      el.resolverState.textContent = data.ok ? "ok" : "?";
    } catch (error) {
      el.resolverState.textContent = `ошибка: ${error.message}`;
    }
  }

  // =====================================================================
  // boot
  // =====================================================================
  function boot() {
    dropLegacyZeroAgeCache();
    dropExpiredCache();
    state.playerPlaceholder = el.playerHost.innerHTML;
    const savedRate = parseFloat(localStorage.getItem("alphy.playbackRate") || "1");
    if ([0.5, 1, 1.25, 1.5, 1.75, 2].includes(savedRate)) state.playbackRate = savedRate;

    const resolverFromUrl = params.get("resolver");
    if (resolverFromUrl) localStorage.setItem(STORE_RESOLVER, cleanBaseUrl(resolverFromUrl));
    const defaultResolver = isLocal ? "http://127.0.0.1:8787" : "https://alphytv.alphy.deno.net";
    const legacyResolvers = [];
    let storedResolver = cleanBaseUrl(localStorage.getItem(STORE_RESOLVER) || "");
    if (!storedResolver || legacyResolvers.includes(storedResolver)) {
      storedResolver = defaultResolver;
      localStorage.setItem(STORE_RESOLVER, storedResolver);
    }
    state.resolverBaseUrl = storedResolver;
    el.resolverInput.value = state.resolverBaseUrl;
    el.resolverState.textContent = "сохранён";

    el.logoBtn.addEventListener("click", (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      go("/");
    });
    el.searchBtn.addEventListener("click", onSearchSubmit);
    el.searchInput.addEventListener("focus", () => {
      currentSearchIndex().catch(() => {});
      warmNewdeafConnections();
      warmCollapsConnections();
    });
    el.searchInput.addEventListener("input", onSuggestInput);
    el.searchInput.addEventListener("blur", () => setTimeout(closeSuggest, 120));
    el.searchInput.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" && moveSuggest(1)) { e.preventDefault(); return; }
      if (e.key === "ArrowUp" && moveSuggest(-1)) { e.preventDefault(); return; }
      if (e.key === "Escape" && suggestRows.length) { e.preventDefault(); closeSuggest(); return; }
      if (e.key !== "Enter") return;
      // A highlighted suggestion wins over the raw text: the viewer picked it.
      if (suggestActive >= 0 && suggestRows[suggestActive]) {
        e.preventDefault();
        chooseSuggest(suggestRows[suggestActive].entry);
        return;
      }
      closeSuggest();
      onSearchSubmit();
    });
    // The catalogue arrives after boot and can be refreshed later, so the index
    // is invalidated rather than built once and left stale.
    window.addEventListener("alphy:catalog-refreshed", () => { suggestIndex = null; });
    el.bookmarksToggle.addEventListener("click", () => go("/bookmarks"));
    el.reviewsToggle?.addEventListener("click", () => {
      const collapsed = !el.reviewsSection?.classList.contains("collapsed");
      el.reviewsSection?.classList.toggle("collapsed", collapsed);
      el.reviewsToggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
      el.reviewsToggle.textContent = collapsed ? "Показать" : "Скрыть";
    });
    el.similarToggle?.addEventListener("click", () => {
      setSimilarCollapsed(!el.similarSection?.classList.contains("collapsed"));
    });
    el.soapBrowseBtn?.addEventListener("click", showSoapBrowser);
    el.soapFilter?.addEventListener("input", renderSoapBrowser);
    el.soapToggle?.addEventListener("click", () => {
      state.soapFourKOnly = !(state.soapFourKOnly !== false);
      renderSoapBrowser();
    });
    el.saveResolverBtn.addEventListener("click", saveResolver);
    el.healthBtn.addEventListener("click", () => testResolver());
    window.addEventListener("hashchange", route);
    window.addEventListener("popstate", route);
    window.addEventListener("storage", (event) => {
      if (event.key !== STORE_BOOKMARKS) return;
      updateBookmarksNav();
      syncBookmarkControls();
      if (parseLocationRoute().view === "bookmarks") showBookmarks();
    });
    window.addEventListener("message", onOrtProgress);
    // pagehide is the one lifecycle signal Tizen reliably emits when its browser
    // is backgrounded. Persist the latest position once, instead of compensating
    // with frequent localStorage writes during playback.
    window.addEventListener("pagehide", () => {
      flushTrackedProgress();
      flushOrtProgress();
    });
    bindKeyboard();
    armFullscreenGuard();

    // Migrate legacy hash/query-param deep links to path routes.
    if (location.hash) {
      const legacyPath = location.hash.replace(/^#/, "") || "/";
      if (parseLegacyHash(location.hash)) replaceHash(legacyPath);
    } else {
      if (params.get("kpId")) replaceHash(`/watch/kp/${encodeURIComponent(params.get("kpId"))}`);
      else if (params.get("zenith")) replaceHash(`/watch/zen/${encodeURIComponent(params.get("zenith"))}`);
      else if (params.get("url")) {
        el.searchInput.value = params.get("url");
        onSearchSubmit();
        return;
      } else if (params.get("q")) replaceHash(`/search/${encodeURIComponent(params.get("q"))}`);
    }

    updateBookmarksNav();
    route();
  }

  // Resolve a title to its real Kinopoisk poster URL (avatars.mds.yandex.net),
  // so the catalog can replace a poster whose host is blocked in RU. Matching is
  // by title+year (the item key's number is a zona id, not a Kinopoisk id, so it
  // cannot be used). Reuses searchPoiskkino's localStorage cache.
  async function resolvePosterByTitle(title, year) {
    try {
      const results = await searchPoiskkino(cleanMovieTitle(title), year);
      const movie = chooseMovie(results, title, year);
      return movie?.poster ? String(movie.poster) : "";
    } catch {
      return "";
    }
  }

  // Best EXACT-title match among search hits (year is a soft tie-breaker, since
  // stored years are unreliable). Returning only exact matches keeps a Force
  // update from ever baking in a wrong cover/rating.
  function pickExactMovie(results, title, year) {
    if (!Array.isArray(results) || !results.length) return null;
    const want = normalizeTitle(title);
    const exact = results.filter((m) =>
      [movieTitle(m), m.alternativeName, m.enName]
        .filter(Boolean).map(normalizeTitle).includes(want));
    if (!exact.length) return null;
    return (year && exact.find((m) => String(m.year) === String(year))) || exact[0];
  }

  // A RU-reachable Kinopoisk poster: prefer an already-Yandex URL, else the
  // deterministic st.kp poster (301s to avatars.mds.yandex.net) built from the
  // real kpId. Never returns the unofficial API's kinopoiskapiunofficial.tech host.
  function kinopoiskPosterUrl(...candidates) {
    for (const c of candidates) {
      const u = c?.poster || "";
      try { if (/(^|\.)yandex\.net$/.test(new URL(u).hostname)) return u; } catch { /* not a URL */ }
    }
    const kpId = candidates.find((c) => /^\d+$/.test(String(c?.kpId)))?.kpId;
    return kpId ? `https://st.kp.yandex.net/images/film_iphone/iphone360_${kpId}.jpg` : "";
  }

  // Re-resolve cover + rating for an existing curated item by title, WITHOUT
  // touching its target (player/links). The /movie detail endpoint recovers the
  // IMDb rating + imdbId even when /search has fallen back to the unofficial API
  // (whose search hits carry no IMDb). Returns ok:false when no exact match.
  async function resolveCardMeta(title, year) {
    try {
      const results = await searchPoiskkino(cleanMovieTitle(title), "");
      const hit = pickExactMovie(results, title, year);
      if (!hit?.kpId) return { ok: false };
      const detail = await fetchMovieMeta(hit.kpId);
      const m = detail || hit;
      const num = (v) => (
        v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v))
          ? Number(v)
          : null
      );
      const list = (v) => (Array.isArray(v) ? v.filter(Boolean).map(String) : []);
      return {
        ok: true,
        kpId: hit.kpId,
        poster: kinopoiskPosterUrl(m, hit),
        rating: { kp: num(m.rating?.kp) ?? num(hit.rating?.kp), imdb: num(m.rating?.imdb) ?? num(hit.rating?.imdb) },
        imdbId: m.externalId?.imdb || hit.externalId?.imdb || "",
        name: movieTitle(m) || title,
        year: m.year || hit.year || year || "",
        // Descriptive metadata rides along on the /movie call the refresh already
        // makes, so baking it into the curated snapshot is free. Once stored, the
        // watch page renders жанр/страна/режиссёр/актёры for that title with no
        // request at all — that is the whole point of curating it here.
        isSeries: m.isSeries ?? hit.isSeries ?? false,
        movieLength: num(m.movieLength) ?? num(hit.movieLength),
        description: m.description || m.shortDescription || "",
        ageRating: num(m.ageRating),
        ratingMpaa: m.ratingMpaa || "",
        genres: list(m.genres),
        countries: list(m.countries),
        directors: list(m.directors),
        cast: list(m.cast),
        people: {
          directors: personRefList(m.people?.directors, 3),
          cast: personRefList(m.people?.cast, 8),
        },
      };
    } catch {
      return { ok: false };
    }
  }

  window.alphyBridge = {
    getCurrentCuratedItem: currentCuratedItem,
    openCuratedItem,
    addCardBookmark,
    armCardIntent,
    armRecommendationIntent,
    prepareTarget,
    prepareRecommendation,
    openRecommendationItem,
    resolveKpPlaybackSource,
    resolveZenithParsed,
    layoutMobileGrid,
    resolvePosterByTitle,
    resolveCardMeta,
    resolverJson,
    fillGridLetterboxd,
    _test: {
      ageBadge,
      matchNewdeafMetadata,
      newdeafPageType,
      pickExactNewdeafResult,
      cleanNewdeafTitle,
      normalizeTitle,
      newdeafSerialHint,
      resolveRecommendationTarget,
      normalizeLiftwSearchPayload,
      liftwEmbedCandidates,
      hedgedRequest,
      fetchLiftwEmbed,
      bindSuggestActivation,
      liftwMediaBroker,
      liftwMeta,
      liftwTextTracks,
      liftwTarget,
      isLiftwMediaUrl,
      liftwOpaqueUri,
      liftwUriFromOpaque,
      bestLiftwSource,
      bestZenithSource,
      chooseCollapsSource,
      pickLiftwLadder,
      topDashRepresentation,
      qualityLabel,
      liftwRuntimeMinutes,
      liftwCandidateScore,
      findLiftwByKpId,
      liftwKpIdFor,
      letterboxdEndpointOrder,
      letterboxdShardIndex,
      letterboxdRating,
      letterboxdBatch,
      letterboxdReviews,
      bakedLetterboxd,
      applySearchDelta,
      loadShard,
      loadSearchRows,
      searchPoiskkino,
      loadCdnLetter,
      currentSearchPointer,
      matchShard,
      fillGridLetterboxd,
      LETTERBOXD_ENDPOINTS,
      isPlaceholderTitle,
      mergeMetadata,
      metadataIsFull,
      canonicalHistoryKey,
      collapseHistory,
      historyEntryMeta,
      formatDuration,
      audioTag,
      audioNameFor,
      isBlockedAudioName,
      shakaAudioChoices,
      mediaLanguageFamily,
      cleanAudioPreference,
      audioPreferenceForChoice,
      chooseAudioPreference,
      cleanSubtitlePreference,
      subtitlePreferenceForTrack,
      chooseSubtitleTrack,
      selectShakaAudio,
      // audioNameFor joins manifest tracks to the embed's dub names, which live
      // on state; tests need to seed them.
      setAudioNames: (names) => { state.audioNames = names; },
      setBlockedAudioNames: (names) => { state.blockedAudioNames = names; },
      setLiftwManifestFetcher: (fetcher) => { liftwManifestFetcher = fetcher; },
      samsungTizenVideoDevice,
      weakVideoDevice,
      progressHook,
      soapHlsConfig,
      startPlaybackIfAllowed,
      carryTizenPlayIntent: () => { state.tizenPlayIntentUntil = Date.now() + 30000; },
      tizenVideoMode: TIZEN_VIDEO_MODE,
      parseZenithEmbed,
      normalizeSerialSeasons,
      chooseSerialSelection,
      chooseCollapsSelection,
      chooseOpravarSelection,
      parsePathRoute,
      hashFor,
      keyFor,
      normalizeCollapsSources,
      isCollapsControlUrl,
      isOpaqueFetchUrl,
      sanitizeOrtifiedHtml,
    },
  };

  boot();
})();
