// Instant curated-catalog bootstrap: the live jsDelivr branch first, then the
// immutable app snapshot as fallback.
(function () {
  "use strict";

  const CONFIG_PATH = "/curated-config.json";
  const PUBLIC_CATALOG_PATH = "/curated-live.json";
  const ADMIN_CATALOG_PATH = "/api/admin/catalog";
  const PRIMARY_CDN_URL =
    "https://cdn.jsdelivr.net/gh/udbv4d2wayz3am6d2kwskzvtvs8q/rfb2akkdbet2am996jvrftk67ydv3sz5s2ve@catalog-cdn/curated-fallback.json";
  const STATIC_FALLBACK_URL =
    window.__alphyAssetUrl?.("curated-fallback.json") || "/curated-fallback.json";
  const CACHE_KEY = "alphy.curated.public.v3";
  const REFRESH_KEY = "alphy.curated.public-refresh.v2";
  const REFRESH_MIN_MS = 5 * 60 * 1000;
  const nativeFetch = window.fetch.bind(window);

  let primaryPromise = null;
  let fallbackPromise = null;
  let refreshPromise = null;
  let refreshScheduled = false;

  function revisionOf(value) {
    const revision = Number(value?.revision);
    return Number.isFinite(revision) && revision >= 0 ? revision : -1;
  }

  function validCatalog(value) {
    return value &&
      Number(value.schema) === 1 &&
      revisionOf(value) >= 0 &&
      Array.isArray(value.lists);
  }

  function jsonResponse(value) {
    return new Response(JSON.stringify(value), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  function readCachedCatalog() {
    try {
      const saved = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
      if (!validCatalog(saved?.catalog)) return null;
      return saved.catalog;
    } catch {
      return null;
    }
  }

  function storeIfNewer(catalog) {
    if (!validCatalog(catalog)) return;
    try {
      const current = readCachedCatalog();
      if (current && revisionOf(current) > revisionOf(catalog)) return;
      localStorage.setItem(CACHE_KEY, JSON.stringify({
        revision: revisionOf(catalog),
        savedAt: Date.now(),
        catalog,
      }));
    } catch {
      // Storage is only an acceleration layer.
    }
  }

  function refreshedRecently() {
    try {
      const refreshedAt = Number(localStorage.getItem(REFRESH_KEY) || 0);
      return refreshedAt > 0 && Date.now() - refreshedAt < REFRESH_MIN_MS;
    } catch {
      return false;
    }
  }

  function markRefreshed() {
    try { localStorage.setItem(REFRESH_KEY, String(Date.now())); } catch { /* optional */ }
  }

  function activeCatalogState() {
    const api = window.alphyCatalog;
    const state = api?._test?.state;
    return api && state ? { api, state } : null;
  }

  function applyFreshWhenReady(catalog) {
    if (!validCatalog(catalog)) return;
    let attempts = 0;
    const attempt = () => {
      const active = activeCatalogState();
      if (!active) {
        if (attempts++ < 80) setTimeout(attempt, 25);
        return;
      }
      const { api, state } = active;
      if (api.isAdmin?.() || state.dirty) return;
      if (revisionOf(catalog) < revisionOf(state.catalog)) return;
      if (revisionOf(catalog) === revisionOf(state.catalog) &&
          String(catalog.enrichmentVersion || "") <= String(state.catalog.enrichmentVersion || "")) return;
      state.catalog = catalog;
      api.render();
      try {
        window.dispatchEvent(new CustomEvent("alphy:catalog-refreshed", {
          detail: { revision: revisionOf(catalog), source: "jsdelivr" },
        }));
      } catch {
        // Rendering already happened; the event is informational only.
      }
    };
    attempt();
  }

  async function fetchCatalogJson(url, options) {
    const response = await nativeFetch(url, options);
    if (!response.ok) throw new Error(`catalog ${response.status}`);
    const catalog = await response.json();
    if (!validCatalog(catalog)) throw new Error("catalog payload is invalid");
    return catalog;
  }

  function loadPrimary() {
    if (primaryPromise) return primaryPromise;
    primaryPromise = fetchCatalogJson(PRIMARY_CDN_URL, {
      cache: "no-cache",
      credentials: "omit",
      mode: "cors",
    }).then((catalog) => {
      storeIfNewer(catalog);
      markRefreshed();
      applyFreshWhenReady(catalog);
      return catalog;
    }).finally(() => {
      primaryPromise = null;
    });
    return primaryPromise;
  }

  function loadVercelFallback() {
    if (fallbackPromise) return fallbackPromise;
    fallbackPromise = fetchCatalogJson(STATIC_FALLBACK_URL, {
      cache: "force-cache",
      credentials: "omit",
    }).then((catalog) => {
      storeIfNewer(catalog);
      applyFreshWhenReady(catalog);
      return catalog;
    }).finally(() => {
      fallbackPromise = null;
    });
    return fallbackPromise;
  }

  function refreshInBackground() {
    refreshScheduled = false;
    if (refreshedRecently()) return;
    if (!refreshPromise) {
      refreshPromise = loadPrimary()
        .catch(() => null)
        .finally(() => { refreshPromise = null; });
    }
  }

  function scheduleRefresh() {
    if (refreshScheduled || refreshPromise || refreshedRecently()) return;
    refreshScheduled = true;
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(refreshInBackground, { timeout: 500 });
    } else {
      setTimeout(refreshInBackground, 0);
    }
  }

  // Cold open only: start jsDelivr before app.js parses. Warm opens already have
  // a synchronous local snapshot and do not need any render-blocking catalog I/O.
  if (!readCachedCatalog()) loadPrimary().catch(() => {});

  window.fetch = async function alphyCatalogFetch(input, init) {
    let requestUrl;
    try {
      requestUrl = new URL(input instanceof Request ? input.url : String(input), location.href);
    } catch {
      return nativeFetch(input, init);
    }

    if (requestUrl.origin !== location.origin) return nativeFetch(input, init);

    if (requestUrl.pathname === ADMIN_CATALOG_PATH) {
      const response = await nativeFetch(input, init);
      if (response.ok) {
        response.clone().json().then((payload) => {
          if (!validCatalog(payload?.catalog)) return;
          storeIfNewer(payload.catalog);
          markRefreshed();
        }).catch(() => {});
      }
      return response;
    }

    if (requestUrl.pathname === CONFIG_PATH) {
      return jsonResponse({
        blobUrl: PUBLIC_CATALOG_PATH,
        fallbackUrl: STATIC_FALLBACK_URL,
      });
    }

    if (requestUrl.pathname !== PUBLIC_CATALOG_PATH) return nativeFetch(input, init);

    scheduleRefresh();

    const cached = readCachedCatalog();
    if (cached) return jsonResponse(cached);

    try {
      return jsonResponse(await loadPrimary());
    } catch {
      try {
        return jsonResponse(await loadVercelFallback());
      } catch {
        return nativeFetch(PUBLIC_CATALOG_PATH, { cache: "force-cache", credentials: "omit" });
      }
    }
  };

  window.alphyCatalogCache = {
    primaryUrl: PRIMARY_CDN_URL,
    cachedRevision: () => revisionOf(readCachedCatalog()),
    refresh: () => loadPrimary(),
    fallback: () => loadVercelFallback(),
  };
})();
