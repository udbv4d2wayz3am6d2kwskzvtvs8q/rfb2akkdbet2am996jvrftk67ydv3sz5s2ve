import { getZonaLib, zonaUserAgent } from "./zona-runtime-and-loader.js";
import { DEFAULT_TRANSLATORS, RezkaClient } from "./rezka.js";

const DEFAULT_POISKKINO_BASE_URL = "https://api.poiskkino.dev";

let zonaResolveQueue = Promise.resolve();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    try {
      if (url.pathname === "/" || url.pathname === "/health") {
        return json(request, env, { ok: true, service: "alphy-resolver" });
      }

      if (url.pathname === "/search") {
        return await handleSearch(request, env, url);
      }

      if (url.pathname === "/movie") {
        return await handleMovie(request, env, url);
      }

      if (url.pathname.startsWith("/recommendations/")) {
        return await handleRecommendationApi(request, env, url);
      }

      if (url.pathname === "/resolve-zona") {
        return await handleZonaResolve(request, env, url);
      }

      if (url.pathname === "/zenith") {
        return await handleZenith(request, env, url);
      }

      if (url.pathname === "/resolve-opravar") {
        return await handleOpravarResolve(request, env, url);
      }

      if (url.pathname === "/subs") {
        return await handleSubtitles(request, env, url);
      }

      if (url.pathname === "/resolve-rezka") {
        return await handleRezkaResolve(request, env, url);
      }

      return json(request, env, { ok: false, error: "not_found" }, 404);
    } catch (error) {
      return json(request, env, {
        ok: false,
        error: "internal_error",
        message: String(error?.message || error),
      }, 500);
    }
  },
};

async function handleSearch(request, env, url) {
  const query = (url.searchParams.get("q") || "").trim();
  const year = (url.searchParams.get("year") || "").trim();
  const limit = clampInt(url.searchParams.get("limit"), 1, 20, 10);

  if (!query) {
    return json(request, env, { ok: false, error: "missing_q" }, 400);
  }

  const primaryOnly = url.searchParams.get("primaryOnly") === "1";
  const { results, source } = primaryOnly
    ? { results: await poiskkinoSearch(env, query, limit), source: "poiskkino" }
    : await searchWithFallback(env, query, limit);
  // Year is a soft hint: providers (e.g. Newdeaf) and PoiskKino often disagree
  // by a year on the same title, so match within +/-1 and never let the year
  // filter zero out an otherwise-valid result.
  const yearNum = Number.parseInt(year, 10);
  let filtered = results;
  if (Number.isFinite(yearNum)) {
    const near = results.filter((item) => {
      const y = Number.parseInt(item.year, 10);
      return Number.isFinite(y) && Math.abs(y - yearNum) <= 1;
    });
    filtered = near.length ? near : results;
  }

  return json(request, env, {
    ok: true,
    query,
    year: year || null,
    source,
    total: results.length,
    results: filtered,
  });
}

async function handleMovie(request, env, url) {
  const id = (url.searchParams.get("id") || url.searchParams.get("kpId") || "").trim();
  if (!/^\d+$/.test(id)) {
    return json(request, env, { ok: false, error: "missing_or_invalid_id" }, 400);
  }

  const primaryOnly = url.searchParams.get("primaryOnly") === "1";
  const { movie, source } = primaryOnly
    ? { movie: await poiskkinoMovie(env, id), source: "poiskkino" }
    : await movieWithFallback(env, id);
  return json(request, env, { ok: true, source, movie });
}

// Metadata sources, used in order of remaining daily budget:
//   1) api.poiskkino.dev — primary, ~200 req/day per key.
//   2) kinopoiskapiunofficial.tech — fallback, ~500 req/day per key.
//
// Deno can inject the admin-managed registry as `__KEY_POOL_KEYS`. Until the
// one-time runtime link is configured, the old env variables remain a safe
// fallback. Every attempt is reported through `__recordKeyAttempt`, keeping the
// actual secrets out of logs and out of the browser.
const unofficialCursors = new Map();
const poiskkinoCursors = new Map();

function legacyEntries(env, provider) {
  const plural = provider === "poiskkino" ? env.POISKKINO_TOKENS : env.KINOPOISK_UNOFFICIAL_TOKENS;
  const singular = provider === "poiskkino" ? env.POISKKINO_TOKEN : env.KINOPOISK_UNOFFICIAL_TOKEN;
  const values = String(plural || "").split(",").map((value) => value.trim());
  if (singular) values.push(String(singular).trim());
  return [...new Set(values.filter(Boolean))].map((value, index) => ({
    id: `legacy-${provider}-${index + 1}`,
    provider,
    label: `legacy ${provider} ${index + 1}`,
    value,
    scopes: { resolver: true, recommendations: provider === "unofficial" },
  }));
}

function providerKeys(env, provider, scope = "resolver") {
  if (env.__KEY_POOL_MANAGED) {
    return (Array.isArray(env.__KEY_POOL_KEYS) ? env.__KEY_POOL_KEYS : [])
      .filter((entry) => entry?.provider === provider && entry?.scopes?.[scope] === true);
  }
  return legacyEntries(env, provider).filter((entry) => entry.scopes[scope]);
}

function errorStatus(error) {
  return Number(String(error?.message || "").match(/\b([1-5]\d\d)\b/)?.[1]) || 0;
}

async function observedKeyCall(env, entry, operation, run) {
  const started = Date.now();
  try {
    const value = await run(entry.value);
    env.__recordKeyAttempt?.({
      id: entry.id,
      provider: entry.provider,
      label: entry.label,
      operation,
      ok: true,
      status: 200,
      latencyMs: Date.now() - started,
    });
    return value;
  } catch (error) {
    env.__recordKeyAttempt?.({
      id: entry.id,
      provider: entry.provider,
      label: entry.label,
      operation,
      ok: false,
      status: errorStatus(error),
      latencyMs: Date.now() - started,
      error: String(error?.message || error).slice(0, 180),
    });
    throw error;
  }
}

// A key that must not be tried first again. 402/429 = spent for today, 403 =
// the account was deactivated ("User <mail> is inactive or deleted"). Without
// 403 the cursor stayed parked on a dead key forever, so every request paid a
// wasted round trip to it before rotating. Matches poiskkinoRotate's predicate.
function isQuotaError(error) {
  return /\b(40[23]|429)\b/.test(String(error?.message || ""));
}

async function unofficialRotate(entries, env, scope, operation, run) {
  const start = unofficialCursors.get(scope) || 0;
  let lastError;
  for (let i = 0; i < entries.length; i += 1) {
    const idx = (start + i) % entries.length;
    const entry = entries[idx];
    try {
      const value = await observedKeyCall(env, entry, operation, (key) => run(key));
      unofficialCursors.set(scope, idx);
      return { value, index: idx, entry };
    } catch (error) {
      lastError = error;
      if (isQuotaError(error)) unofficialCursors.set(scope, (idx + 1) % entries.length);
    }
  }
  throw lastError || new Error("all unofficial keys exhausted");
}

async function searchWithFallback(env, query, limit) {
  try {
    return { results: await poiskkinoSearch(env, query, limit), source: "poiskkino" };
  } catch (primaryError) {
    const keys = providerKeys(env, "unofficial", "resolver");
    if (!keys.length) throw primaryError;
    try {
      const { value, index } = await unofficialRotate(
        keys, env, "resolver", "search", (key) => unofficialSearch(env, key, query, limit),
      );
      return { results: value, source: `kinopoiskunofficial#${index + 1}` };
    } catch {
      throw primaryError; // everything down -> surface the primary error
    }
  }
}

async function movieWithFallback(env, id) {
  try {
    return { movie: await poiskkinoMovie(env, id), source: "poiskkino" };
  } catch (primaryError) {
    const keys = providerKeys(env, "unofficial", "resolver");
    if (!keys.length) throw primaryError;
    try {
      const { value, index } = await unofficialRotate(
        keys, env, "resolver", "movie", (key) => unofficialMovie(env, key, id),
      );
      return { movie: value, source: `kinopoiskunofficial#${index + 1}` };
    } catch {
      throw primaryError;
    }
  }
}

async function poiskkinoRotate(entries, env, operation, run) {
  const scope = "resolver";
  const start = poiskkinoCursors.get(scope) || 0;
  let lastError;
  for (let i = 0; i < entries.length; i += 1) {
    const idx = (start + i) % entries.length;
    const entry = entries[idx];
    try {
      const value = await observedKeyCall(env, entry, operation, (key) => run(key));
      poiskkinoCursors.set(scope, idx);
      return { value, entry };
    } catch (error) {
      lastError = error;
      // kinopoisk.dev answers 403 ("Превышен дневной лимит") when a key is spent.
      if (/\b(40[23]|429)\b/.test(String(error?.message || ""))) {
        poiskkinoCursors.set(scope, (idx + 1) % entries.length);
      }
    }
  }
  throw lastError || new Error("POISKKINO_TOKEN secret is not configured");
}

async function poiskkinoSearch(env, query, limit) {
  const keys = providerKeys(env, "poiskkino", "resolver");
  if (!keys.length) throw new Error("POISKKINO_TOKEN secret is not configured");
  const apiUrl = new URL("/v1.4/movie/search", poiskkinoBase(env));
  apiUrl.searchParams.set("query", query);
  apiUrl.searchParams.set("limit", String(limit));
  const { value: raw } = await poiskkinoRotate(
    keys, env, "search", (key) => poiskkinoFetch(key, apiUrl),
  );
  const docs = Array.isArray(raw.docs) ? raw.docs : [];
  return docs.map(normalizeMovie);
}

async function poiskkinoMovie(env, id) {
  const keys = providerKeys(env, "poiskkino", "resolver");
  if (!keys.length) throw new Error("POISKKINO_TOKEN secret is not configured");
  const apiUrl = new URL(`/v1.4/movie/${id}`, poiskkinoBase(env));
  const { value } = await poiskkinoRotate(
    keys, env, "movie", (key) => poiskkinoFetch(key, apiUrl),
  );
  return normalizeMovie(value);
}

async function poiskkinoMovies(env, ids) {
  const keys = providerKeys(env, "poiskkino", "resolver");
  if (!keys.length) throw new Error("POISKKINO_TOKEN secret is not configured");
  const apiUrl = new URL("/v1.4/movie", poiskkinoBase(env));
  for (const id of ids) apiUrl.searchParams.append("id", id);
  for (const field of [
    "id", "name", "alternativeName", "enName", "type", "year", "isSeries",
    "movieLength", "seriesLength", "rating", "poster",
  ]) {
    apiUrl.searchParams.append("selectFields", field);
  }
  apiUrl.searchParams.set("limit", String(ids.length));
  const { value: raw } = await poiskkinoRotate(
    keys, env, "recommendations:batch-meta", (key) => poiskkinoFetch(key, apiUrl),
  );
  return (Array.isArray(raw?.docs) ? raw.docs : []).map(normalizeMovie);
}

async function unofficialSearch(env, key, query, limit) {
  const apiUrl = new URL("/api/v2.1/films/search-by-keyword", unofficialBase(env));
  apiUrl.searchParams.set("keyword", query);
  apiUrl.searchParams.set("page", "1");
  const raw = await unofficialFetch(key, apiUrl);
  const films = Array.isArray(raw.films) ? raw.films : [];
  return films.slice(0, limit).map(normalizeUnofficialSearch);
}

async function unofficialMovie(env, key, id) {
  const apiUrl = new URL(`/api/v2.2/films/${id}`, unofficialBase(env));
  return normalizeUnofficialFilm(await unofficialFetch(key, apiUrl));
}

async function handleRecommendationApi(request, env, url) {
  const operation = url.pathname.slice("/recommendations/".length);
  if (operation === "meta") {
    const ids = [...new Set(String(url.searchParams.get("ids") || "")
      .split(",").map((id) => id.trim()).filter((id) => /^\d+$/.test(id)))].slice(0, 24);
    if (!ids.length) return json(request, env, { ok: false, error: "missing_or_invalid_ids" }, 400);
    return json(request, env, { ok: true, movies: await poiskkinoMovies(env, ids) });
  }

  const keys = providerKeys(env, "unofficial", "recommendations");
  if (!keys.length) {
    return json(request, env, { ok: false, error: "recommendation_keys_not_configured" }, 503);
  }

  let apiUrl;
  if (operation === "search") {
    const query = (url.searchParams.get("q") || "").trim();
    if (!query) return json(request, env, { ok: false, error: "missing_q" }, 400);
    apiUrl = new URL("/api/v2.1/films/search-by-keyword", unofficialBase(env));
    apiUrl.searchParams.set("keyword", query);
    apiUrl.searchParams.set("page", "1");
  } else {
    const id = (url.searchParams.get("id") || "").trim();
    if (!/^\d+$/.test(id)) return json(request, env, { ok: false, error: "missing_or_invalid_id" }, 400);
    if (operation === "similars") {
      apiUrl = new URL(`/api/v2.2/films/${id}/similars`, unofficialBase(env));
    } else if (operation === "film") {
      apiUrl = new URL(`/api/v2.2/films/${id}`, unofficialBase(env));
    } else if (operation === "staff") {
      apiUrl = new URL("/api/v1/staff", unofficialBase(env));
      apiUrl.searchParams.set("filmId", id);
    } else {
      return json(request, env, { ok: false, error: "recommendation_endpoint_not_found" }, 404);
    }
  }

  const { value } = await unofficialRotate(
    keys,
    env,
    "recommendations",
    `recommendations:${operation}`,
    (key) => unofficialFetch(key, apiUrl),
  );
  return json(request, env, value);
}

async function unofficialFetch(key, apiUrl) {
  const response = await fetch(apiUrl, {
    headers: { "Accept": "application/json", "X-API-KEY": key },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`KinopoiskUnofficial ${response.status}: ${text.slice(0, 200)}`);
  }
  return JSON.parse(text);
}

function unofficialBase(env) {
  return env.KINOPOISK_UNOFFICIAL_BASE_URL || "https://kinopoiskapiunofficial.tech";
}

async function handleZonaResolve(request, env, url) {
  const kpId = (url.searchParams.get("kpId") || url.searchParams.get("id") || "").trim();
  if (!/^\d+$/.test(kpId)) {
    return json(request, env, { ok: false, error: "missing_or_invalid_kpId" }, 400);
  }
  const resolved = await enqueueZonaResolve(() => resolveZonaInPureJs(kpId));
  if (!resolved.embedUrl) {
    // mzona occasionally returns an empty body when its shared egress is
    // rate-limited. That is a transient upstream failure, not a successful
    // "title has no Zenith" result. Returning ok:false lets clients retry and,
    // crucially, prevents an empty mapping from looking cacheable.
    return json(request, env, {
      ok: false,
      error: "zona_upstream_empty",
      message: "Zona временно не вернула Zenith embed",
      ...resolved,
    }, 503);
  }
  return json(request, env, { ok: true, ...resolved });
}

async function handleZenith(request, env, url) {
  const idOrUrl = (url.searchParams.get("id") || url.searchParams.get("url") || "").trim();
  const id = idOrUrl.match(/(?:^|\/)(\d+)(?:$|[/?#])/)?.[1] || idOrUrl.match(/^\d+$/)?.[0] || "";
  if (!id) {
    return json(request, env, { ok: false, error: "missing_or_invalid_zenith_id" }, 400);
  }

  const embedUrl = `https://api.zenithjs.ws/embed/movie/${id}`;
  const response = await fetch(embedUrl, {
    headers: {
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Origin": "https://kinoserial.online",
      "Referer": "https://kinoserial.online/",
      "User-Agent": zonaUserAgent(),
    },
  });
  const html = await response.text();
  if (!response.ok) {
    throw new Error(`Zenith ${response.status}: ${html.slice(0, 200)}`);
  }

  const parsed = parseZenithEmbed(html);
  return json(request, env, {
    ok: true,
    id,
    embedUrl,
    status: response.status,
    bytes: html.length,
    sources: parsed.sources,
    meta: parsed.meta,
    playlist: parsed.playlist,
    hasSources: !!(parsed.sources.dash || parsed.sources.dasha || parsed.sources.hls),
  });
}

async function handleOpravarResolve(request, env, url) {
  const videoId = (url.searchParams.get("videoId") || "").trim();
  const playerUrl = safeOpravarUrl(url.searchParams.get("url") || "");
  if (!playerUrl) {
    return json(request, env, { ok: false, error: "missing_or_invalid_opravar_url" }, 400);
  }

  if (videoId) {
    if (!/^\d+$/.test(videoId)) {
      return json(request, env, { ok: false, error: "invalid_video_id" }, 400);
    }
    const resolved = await fetchOpravarVideo(videoId, playerUrl, url.searchParams.get("base") || "");
    return json(request, env, { ok: true, provider: "opravar", ...resolved });
  }

  const pageUrl = safeNewdeafUrl(url.searchParams.get("pageUrl") || "");
  const response = await fetch(playerUrl, {
    redirect: "follow",
    headers: opravarHeaders(pageUrl || "https://newdeaf.co/"),
  });
  const html = await response.text();
  if (!response.ok) {
    throw new Error(`Opravar ${response.status}: ${html.slice(0, 200)}`);
  }
  if (html.length > 2_000_000) {
    throw new Error("Opravar player document is unexpectedly large");
  }

  // gencit.info/bil/N 301-redirects to the current (rotating) player host, e.g.
  // ceramet.net today. Everything downstream is derived from that resolved host
  // and the spare host the page itself declares — never hardcoded — because the
  // provider rotates its domains (ddos-guard fronted) like Newdeaf's mirrors.
  const base = safePublicOrigin(new URL(response.url).origin);
  const parsed = parseOpravarPage(html, base);
  if (!parsed.source || !parsed.playlist.length) {
    // Diagnostic (no secrets): tells apart "ddos-guard served Deno a stub"
    // (tiny html / no inputData) from "host rotated past our rewrite" (real
    // html but source unresolved).
    const playerTag = html.match(/<div\b[^>]*\bid=["']videoplayer\d+["'][^>]*>/i)?.[0] || "";
    return json(request, env, {
      ok: false,
      error: "opravar_parse_failed",
      diag: {
        status: response.status,
        finalUrl: response.url,
        htmlLength: html.length,
        hasInputData: /id=["']inputData["']/i.test(html),
        hasConfig: /data-config\s*=/i.test(html),
        spareSeen: htmlAttr(playerTag, "data-spare") || htmlAttr(playerTag, "data-domainspare") || null,
        sourceResolved: !!parsed.source,
        playlistCount: parsed.playlist.length,
        titleSnippet: (html.match(/<title>([^<]*)<\/title>/i)?.[1] || "").slice(0, 100),
      },
    }, 502);
  }
  return json(request, env, {
    ok: true,
    provider: "opravar",
    requestedUrl: playerUrl,
    resolvedUrl: response.url,
    base,
    pageUrl,
    ...parsed,
  });
}

// gencit.info/bil/N -> follow the 301 to learn the current player host so the
// episode/voice API (responce.php) is called on the live host, not a stale one.
async function resolveOpravarBaseOrigin(playerUrl) {
  const response = await fetch(playerUrl, {
    redirect: "follow",
    headers: opravarHeaders("https://newdeaf.co/"),
  });
  await response.text().catch(() => {});
  return safePublicOrigin(new URL(response.url).origin);
}

async function fetchOpravarVideo(videoId, playerUrl, baseParam) {
  const base = safePublicOrigin(baseParam) || (await resolveOpravarBaseOrigin(playerUrl));
  if (!base) throw new Error("Opravar: could not determine current player host");
  const apiUrl = `${base}/player/responce.php?video_id=${encodeURIComponent(videoId)}`;
  const response = await fetch(apiUrl, {
    headers: opravarHeaders(playerUrl),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Opravar video ${response.status}: ${text.slice(0, 200)}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Opravar video API returned invalid JSON");
  }
  const originalSource = data.src || data.hls || "";
  const source = rewriteOpravarMediaHost(originalSource, data.spare);
  if (!source) throw new Error("Opravar video API did not expose a CORS-open spare stream");

  return {
    videoId: Number(videoId),
    source,
    spare: safePublicOrigin(data.spare),
    expiresAt: mediaExpiry(source),
    subtitles: normalizeOpravarSubtitles(data.subtitles),
    thumbnail: data.thumbnail?.src ? rewriteOpravarMediaHost(data.thumbnail.src, data.spare) : null,
  };
}

function parseOpravarPage(html, base) {
  const playerTag = String(html || "").match(/<div\b[^>]*\bid=["']videoplayer\d+["'][^>]*>/i)?.[0] || "";
  const inputMatch = String(html || "").match(/<div\b[^>]*\bid=["']inputData["'][^>]*>([\s\S]*?)<\/div>/i);
  const inputTag = inputMatch?.[0]?.slice(0, inputMatch[0].indexOf(">") + 1) || "";
  const config = parseJson(htmlAttr(playerTag, "data-config")) || {};
  const spare = safePublicOrigin(htmlAttr(playerTag, "data-spare") || htmlAttr(playerTag, "data-domainspare"));
  const source = rewriteOpravarMediaHost(config.hls || config.src || "", spare);
  const playlistData = parseJson(decodeHtml(inputMatch?.[1] || "")) || {};
  const playlist = normalizeOpravarPlaylist(playlistData);
  const current = {
    season: numberOrNull(htmlAttr(inputTag, "data-season")),
    episode: numberOrNull(htmlAttr(inputTag, "data-episode")),
    voiceId: numberOrNull(String(htmlAttr(inputTag, "data-voice") || "").split("#")[0]),
  };
  current.videoId = findOpravarVideoId(playlist, current);

  return {
    base: safePublicOrigin(base) || null,
    source,
    spare,
    expiresAt: mediaExpiry(source),
    subtitles: normalizeOpravarSubtitles({
      original: htmlAttr(playerTag, "data-original_subtitle"),
      ru: htmlAttr(playerTag, "data-ru_subtitle"),
      en: htmlAttr(playerTag, "data-en_subtitle"),
      ua: htmlAttr(playerTag, "data-ua_subtitle"),
    }),
    current,
    playlist,
  };
}

function normalizeOpravarPlaylist(raw) {
  const seasons = [];
  for (const [seasonKey, rawEpisodes] of Object.entries(raw || {})) {
    const season = Number(seasonKey);
    if (!Number.isFinite(season)) continue;
    const episodeEntries = Array.isArray(rawEpisodes)
      ? rawEpisodes.map((voices, index) => [String(index), voices])
      : Object.entries(rawEpisodes || {});
    const episodes = [];
    for (const [episodeKey, rawVoices] of episodeEntries) {
      if (!Array.isArray(rawVoices)) continue;
      const voices = rawVoices.map((voice) => ({
        videoId: numberOrNull(voice?.video_id),
        voiceId: numberOrNull(voice?.voice_id),
        name: String(voice?.voice_name || "Озвучка"),
        duration: numberOrNull(voice?.duration),
      })).filter((voice) => voice.videoId != null && voice.voiceId != null);
      if (!voices.length) continue;
      const episode = numberOrNull(voices[0]?.episode ?? rawVoices[0]?.episode ?? episodeKey);
      if (episode == null) continue;
      episodes.push({ episode, voices });
    }
    episodes.sort((a, b) => a.episode - b.episode);
    if (episodes.length) seasons.push({ season, episodes });
  }
  seasons.sort((a, b) => a.season - b.season);
  return seasons;
}

function findOpravarVideoId(playlist, current) {
  const season = playlist.find((item) => item.season === current.season);
  const episode = season?.episodes.find((item) => item.episode === current.episode);
  return episode?.voices.find((item) => item.voiceId === current.voiceId)?.videoId
    ?? episode?.voices[0]?.videoId
    ?? null;
}

function normalizeOpravarSubtitles(raw) {
  const labels = {
    original: ["original", "Original"],
    ru: ["ru", "Русские"],
    en: ["en", "English"],
    ua: ["uk", "Українські"],
  };
  return Object.entries(raw || {}).flatMap(([key, value]) => {
    if (!value || !labels[key]) return [];
    try {
      const parsed = new URL(String(value));
      // VTT is served CORS-open (ACAO:*) from the rotating player host, so accept
      // any public https .vtt rather than a hardcoded host.
      if (parsed.protocol !== "https:" || !isPublicHost(parsed.hostname) || !/\.vtt$/i.test(parsed.pathname)) return [];
      return [{ language: labels[key][0], label: labels[key][1], url: parsed.href }];
    } catch {
      return [];
    }
  });
}

// Move the signed media path from the primary host (e.g. cdn1.ceramet.net) to
// the reserve host the provider itself declares (data-spare / API `spare`, e.g.
// a1.flintraxvk-companet.pro or f1.werberk.pro). The reserve regenerates nested
// playlist/segment URLs on its host with wildcard CORS, so Shaka on our origin
// can read it. Hosts rotate, so nothing here is hardcoded — we only require both
// sides to be public https hosts.
function rewriteOpravarMediaHost(value, spareValue) {
  try {
    const media = new URL(String(value || ""));
    const spareOrigin = safePublicOrigin(spareValue);
    if (media.protocol !== "https:" || !isPublicHost(media.hostname) || !spareOrigin) return null;
    media.host = new URL(spareOrigin).host;
    return media.href;
  } catch {
    return null;
  }
}

// A public https origin: rejects localhost, bare IPs, and host:port. Used for the
// declared spare/reserve host and the redirect-resolved player base.
function safePublicOrigin(value) {
  try {
    const parsed = new URL(String(value || ""));
    if (parsed.protocol !== "https:" || !isPublicHost(parsed.hostname)) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function isPublicHost(host) {
  const h = String(host || "").toLowerCase();
  if (!h || h === "localhost" || h.endsWith(".localhost")) return false;
  if (h.includes(":")) return false; // no IPv6 / host:port
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return false; // no bare IPv4
  if (!h.includes(".")) return false; // must be a dotted domain
  return /^[a-z0-9.-]+$/.test(h);
}

function safeOpravarUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    if (parsed.protocol !== "https:" || !["gencit.info", "opravar.online"].includes(parsed.hostname)) return null;
    if (!/^\/bil\/\d+\/?$/i.test(parsed.pathname)) return null;
    parsed.username = "";
    parsed.password = "";
    parsed.hash = "";
    return parsed.href;
  } catch {
    return null;
  }
}

function safeNewdeafUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    if (parsed.protocol !== "https:" || !/(^|\.)newdeaf\.co$/i.test(parsed.hostname)) return null;
    parsed.username = "";
    parsed.password = "";
    parsed.hash = "";
    return parsed.href;
  } catch {
    return null;
  }
}

function opravarHeaders(referer) {
  return {
    "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
    "Referer": referer,
    "User-Agent": zonaUserAgent(),
  };
}

function htmlAttr(tag, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(tag || "").match(new RegExp(`\\b${escaped}\\s*=\\s*([\"'])([\\s\\S]*?)\\1`, "i"));
  return decodeHtml(match?.[2] || "");
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function parseJson(value) {
  try {
    return JSON.parse(String(value || "").trim());
  } catch {
    return null;
  }
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function mediaExpiry(value) {
  try {
    const parts = new URL(String(value || "")).pathname.split("/");
    const epoch = parts.map((part) => Number(part)).find((part) => Number.isInteger(part) && part > 1_500_000_000);
    return epoch ? epoch * 1000 : null;
  } catch {
    return null;
  }
}

// --- Subtitles via the OpenSubtitles v3 Stremio addon, proxied server-side ---
//
// Why this lives on the resolver and not in the browser: the addon manifest
// (opensubtitles-v3.strem.io) and the actual .srt files (subs5.strem.io) are
// both Cloudflare-fronted, which the RU last mile throttles, and every other
// public subtitle host (opensubtitles/subsource/subdl/podnapisi) is the same.
// Deno's EU egress reaches Cloudflare fine, so the resolver fetches the manifest
// and the chosen file server-side and returns the raw subtitle text with CORS.
// The RU browser only ever talks to this (RU-reachable) endpoint. subs5 serves
// re-encoded UTF-8 SRT with a 1-year CDN cache and an effectively unlimited
// quota, so repeat fetches are cheap CDN hits, not live OpenSubtitles downloads.
const OPENSUBS_V3_BASE = "https://opensubtitles-v3.strem.io";
// OpenSubtitles uses ISO 639-2/B 3-letter codes; map the ones we surface.
const SUBS_LANG3_TO_2 = { rus: "ru", eng: "en", ukr: "uk" };
const SUBS_LABELS = { ru: "Русские", en: "English", uk: "Українські" };

async function handleSubtitles(request, env, url) {
  const imdb = (url.searchParams.get("imdb") || url.searchParams.get("id") || "").trim();
  if (!/^tt\d{5,}$/i.test(imdb)) {
    return json(request, env, { ok: false, error: "missing_or_invalid_imdb" }, 400);
  }
  const type = url.searchParams.get("type") === "series" ? "series" : "movie";
  const season = (url.searchParams.get("season") || "").trim();
  const episode = (url.searchParams.get("episode") || "").trim();
  const wanted = (url.searchParams.get("lang") || "ru,en")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const perLang = clampInt(url.searchParams.get("perLang"), 1, 3, 1);

  let resource;
  if (type === "series") {
    if (!/^\d+$/.test(season) || !/^\d+$/.test(episode)) {
      return json(request, env, { ok: false, error: "series_requires_season_episode" }, 400);
    }
    resource = `series/${imdb}:${season}:${episode}`;
  } else {
    resource = `movie/${imdb}`;
  }

  const manifest = await fetchJsonWithTimeout(`${OPENSUBS_V3_BASE}/subtitles/${resource}.json`, 12000);
  const entries = Array.isArray(manifest?.subtitles) ? manifest.subtitles : [];

  // Take up to perLang entries per requested language, preserving the addon's
  // own relevance order. (The manifest is large — 70-100 entries — so this also
  // bounds how many files we actually download.)
  const picks = [];
  const perLangCount = new Map();
  for (const entry of entries) {
    const lang2 = SUBS_LANG3_TO_2[String(entry?.lang || "").toLowerCase()] || String(entry?.lang || "").toLowerCase();
    if (!wanted.includes(lang2)) continue;
    if (!/^https:\/\//i.test(entry?.url || "")) continue;
    const count = perLangCount.get(lang2) || 0;
    if (count >= perLang) continue;
    perLangCount.set(lang2, count + 1);
    picks.push({ lang2, url: entry.url, suffix: count });
  }

  // Fetch the chosen files server-side (CORS is irrelevant here), in parallel.
  const results = (await Promise.all(picks.map(async (pick) => {
    try {
      const res = await fetchWithTimeout(pick.url, { headers: { "Accept": "text/plain,*/*" } }, 15000);
      if (!res.ok) return null;
      const content = await res.text();
      const clean = content.replace(/^﻿/, "").trim();
      // Guard against the upstream returning an HTML error/anti-bot page.
      if (!clean || /^<!doctype html|^<html[\s>]/i.test(clean)) return null;
      if (!/-->/m.test(clean) && !/^WEBVTT/i.test(clean)) return null;
      const label = SUBS_LABELS[pick.lang2] || pick.lang2.toUpperCase();
      return {
        language: pick.lang2,
        label: pick.suffix ? `${label} ${pick.suffix + 1}` : label,
        format: /^WEBVTT/i.test(clean) ? "vtt" : "srt",
        content,
      };
    } catch {
      return null;
    }
  }))).filter(Boolean);

  return new Response(JSON.stringify({ ok: true, imdb, type, total: entries.length, results }), {
    status: 200,
    headers: {
      ...corsHeaders(request, env),
      "content-type": "application/json; charset=utf-8",
      // Safe to cache: a given (title, episode) maps to the same subtitle set, and
      // subs5 itself caches the files for a year. Keeps repeat loads off the resolver.
      "cache-control": "public, max-age=86400",
    },
  });
}

// LAST-RESORT source: HDRezka anonymous MP4s. Called by the client only after
// Collaps AND Zona/Zenith have all failed for a title. The video bytes stream
// browser -> Voidboost directly; this endpoint only relays the small signed URLs
// (a few KB), so it adds no video bandwidth to the resolver. Signed URLs are
// short-lived, hence no-store.
async function handleRezkaResolve(request, env, url) {
  // Cloudflare rewrites CF-Connecting-IP on cross-origin Worker subrequests, so
  // Rezka signs for the PoP and Voidboost rejects the viewer. The Deno wrapper
  // injects a trusted x-alphy-client-ip and is the supported production relay.
  if (request.cf) {
    return json(request, env, { ok: false, error: "rezka_requires_deno_relay" }, 501);
  }
  const kp = (url.searchParams.get("kp") || url.searchParams.get("kpId") || "").trim();
  const id = (url.searchParams.get("id") || "").trim();
  const title = (url.searchParams.get("title") || "").trim();
  const year = (url.searchParams.get("year") || "").trim();
  const translator = (url.searchParams.get("translator") || "").trim();

  // Shape first, then sufficiency: `?kp=abc` should say the kp is malformed, not
  // that a title is missing.
  if (kp && !/^\d+$/.test(kp)) return json(request, env, { ok: false, error: "invalid_kp" }, 400);
  if (id && !/^\d+$/.test(id)) return json(request, env, { ok: false, error: "invalid_id" }, 400);
  if (translator && !/^\d+$/.test(translator)) {
    return json(request, env, { ok: false, error: "invalid_translator" }, 400);
  }
  // A title (or a Rezka id) is required, not just a kpId. Turning a bare kpId
  // into a title meant asking Collaps from this host, which put our own egress IP
  // in front of a source on every resolve; the caller holds a title in every path
  // that reaches here. `kp` is still accepted and echoed back as a label.
  if (!id && !title) {
    return json(request, env, { ok: false, error: "missing_id_or_title" }, 400);
  }

  const client = new RezkaClient({
    clientIp:
      request.headers.get("x-alphy-client-ip") ||
      request.headers.get("cf-connecting-ip") ||
      "",
  });
  if (!client.clientIp) {
    return json(request, env, { ok: false, error: "rezka_client_ip_unavailable" }, 503);
  }
  let resolved;
  try {
    resolved = await client.resolve({
      kpId: kp || null,
      rezkaId: id || null,
      title: title || null,
      year: year || null,
      translatorId: translator || null,
      withTranslators: true,
    });
  } catch (error) {
    return json(request, env, {
      ok: false,
      error: "rezka_resolve_failed",
      message: String(error?.message || error),
    }, 502);
  }

  if (!resolved.best?.url) {
    return json(request, env, {
      ok: false,
      error: "rezka_no_anonymous_stream",
      movie: resolved.movie,
    }, 502);
  }

  return json(request, env, {
    ok: true,
    provider: "rezka",
    movie: {
      rezkaId: resolved.movie.rezkaId,
      title: resolved.movie.title,
      year: resolved.movie.year,
    },
    translatorId: resolved.translatorId,
    translators: resolved.translators,
    translatorCandidates: resolved.translators.length
      ? []
      : [...new Set([resolved.translatorId, ...DEFAULT_TRANSLATORS])].map((id) => ({
        id,
        name: `Дорожка ${id}`,
        tentative: true,
      })),
    streams: resolved.playable.map((s) => ({ label: s.label, quality: s.quality, url: s.url })),
    subtitles: resolved.subtitles,
    best: { label: resolved.best.label, quality: resolved.best.quality, url: resolved.best.url },
  });
}

async function fetchWithTimeout(targetUrl, init = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(targetUrl, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJsonWithTimeout(targetUrl, timeoutMs) {
  const res = await fetchWithTimeout(targetUrl, { headers: { "Accept": "application/json" } }, timeoutMs);
  const text = await res.text();
  if (!res.ok) throw new Error(`Subtitles manifest ${res.status}: ${text.slice(0, 150)}`);
  return JSON.parse(text);
}

async function poiskkinoFetch(key, apiUrl) {
  const response = await fetch(apiUrl, {
    headers: {
      "Accept": "application/json",
      "X-API-KEY": key,
    },
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`PoiskKino ${response.status}: ${text.slice(0, 300)}`);
  }

  return JSON.parse(text);
}

// kinopoisk.dev returns the whole document (we never send selectFields), so the
// descriptive fields below are already paid for by the /movie request the client
// makes anyway. Passing them through costs zero extra upstream calls and is what
// lets the watch page show возраст/жанр/страна/режиссёр/актёры without a second
// API round trip.
const NAME_LIMIT = 24;

function nameList(value, limit = NAME_LIMIT) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value) {
    const name = String(entry?.name || entry || "").trim();
    if (name && !out.includes(name)) out.push(name);
    if (out.length >= limit) break;
  }
  return out;
}

// kinopoisk.dev `persons`: [{ name, enName, profession, enProfession, photo }].
// Russian `profession` values are plural ("режиссеры", "актеры"); enProfession is
// the stable singular key, so match on it first and fall back to the RU string.
function personsByProfession(value, enProfession, ruProfession, limit) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const person of value) {
    const en = String(person?.enProfession || "").toLowerCase();
    const ru = String(person?.profession || "").toLowerCase();
    if (en ? en !== enProfession : !ru.startsWith(ruProfession)) continue;
    const name = String(person?.name || person?.enName || "").trim();
    if (name && !out.includes(name)) out.push(name);
    if (out.length >= limit) break;
  }
  return out;
}

function personRefsByProfession(value, enProfession, ruProfession, limit) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const person of value) {
    const en = String(person?.enProfession || "").toLowerCase();
    const ru = String(person?.profession || "").toLowerCase();
    if (en ? en !== enProfession : !ru.startsWith(ruProfession)) continue;
    const id = String(person?.id || person?.staffId || "");
    const name = String(person?.name || person?.nameRu || person?.enName || person?.nameEn || "").trim();
    if (!/^\d+$/.test(id) || !name || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name });
    if (out.length >= limit) break;
  }
  return out;
}

function normalizeMovie(item) {
  return {
    kpId: item.id ?? null,
    name: item.name ?? null,
    alternativeName: item.alternativeName ?? null,
    enName: item.enName ?? null,
    type: item.type ?? null,
    year: item.year ?? null,
    isSeries: item.isSeries ?? false,
    movieLength: item.movieLength ?? null,
    seriesLength: item.seriesLength ?? null,
    description: item.description ?? null,
    shortDescription: item.shortDescription ?? null,
    slogan: item.slogan ?? null,
    poster: item.poster?.url || item.poster?.previewUrl || null,
    ageRating:
      item.ageRating !== null && item.ageRating !== undefined && item.ageRating !== "" &&
      Number.isFinite(Number(item.ageRating))
        ? Number(item.ageRating)
        : null,
    ratingMpaa: item.ratingMpaa || null,
    genres: nameList(item.genres),
    countries: nameList(item.countries),
    directors: personsByProfession(item.persons, "director", "режисс", 3),
    cast: personsByProfession(item.persons, "actor", "актер", 8),
    people: {
      directors: personRefsByProfession(item.persons, "director", "режисс", 3),
      cast: personRefsByProfession(item.persons, "actor", "актер", 8),
    },
    externalId: {
      imdb: item.externalId?.imdb || item.imdbId || null,
      tmdb: item.externalId?.tmdb || item.tmdbId || null,
    },
    rating: {
      kp: item.rating?.kp ?? null,
      imdb: item.rating?.imdb ?? null,
    },
    votes: {
      kp: item.votes?.kp ?? null,
      imdb: item.votes?.imdb ?? null,
    },
  };
}

// kinopoiskapiunofficial.tech /api/v2.2/films/{id} -> our normalized movie shape.
function normalizeUnofficialFilm(item) {
  const year = String(item.year ?? "").match(/\d{4}/)?.[0] || null;
  return {
    kpId: item.kinopoiskId ?? item.filmId ?? null,
    name: item.nameRu || item.nameOriginal || item.nameEn || null,
    alternativeName: item.nameOriginal || null,
    enName: item.nameEn || null,
    type: item.type ?? null,
    year: year ? Number(year) : null,
    isSeries: !!item.serial || /SERIES|TV_SHOW|MINI/i.test(String(item.type || "")),
    movieLength: typeof item.filmLength === "number" ? item.filmLength : null,
    description: item.description ?? null,
    shortDescription: item.shortDescription ?? null,
    slogan: item.slogan ?? null,
    poster: item.posterUrl || item.posterUrlPreview || null,
    // "age16" -> 16. This source exposes no staff list, so directors/cast stay
    // empty here and the client backfills them from /api/v1/staff when needed.
    ageRating: Number(String(item.ratingAgeLimits || "").match(/\d+/)?.[0]) || null,
    ratingMpaa: item.ratingMpaa || null,
    genres: nameList((item.genres || []).map((g) => g?.genre)),
    countries: nameList((item.countries || []).map((c) => c?.country)),
    directors: [],
    cast: [],
    people: { directors: [], cast: [] },
    externalId: {
      imdb: item.imdbId || null,
      tmdb: item.tmdbId || null,
    },
    rating: { kp: numOrNull(item.ratingKinopoisk), imdb: numOrNull(item.ratingImdb) },
    votes: { kp: numOrNull(item.ratingKinopoiskVoteCount), imdb: numOrNull(item.ratingImdbVoteCount) },
  };
}

// kinopoiskapiunofficial.tech /api/v2.1/films/search-by-keyword item. Search hits
// carry only a single string `rating` (KP) and no IMDb rating; year is a string.
function normalizeUnofficialSearch(item) {
  const year = String(item.year ?? "").match(/\d{4}/)?.[0] || null;
  return {
    kpId: item.filmId ?? item.kinopoiskId ?? null,
    name: item.nameRu || item.nameEn || null,
    alternativeName: item.nameEn || null,
    enName: item.nameEn || null,
    type: item.type ?? null,
    year: year ? Number(year) : null,
    isSeries: /SERIES|TV_SHOW|MINI/i.test(String(item.type || "")),
    movieLength: null,
    description: item.description ?? null,
    shortDescription: null,
    poster: item.posterUrl || item.posterUrlPreview || null,
    externalId: {
      imdb: item.imdbId || null,
      tmdb: item.tmdbId || null,
    },
    rating: { kp: ratingStr(item.rating), imdb: null },
    votes: { kp: numOrNull(item.ratingVoteCount), imdb: null },
  };
}

function numOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function ratingStr(value) {
  if (value == null || value === "null" || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function poiskkinoBase(env) {
  return env.POISKKINO_BASE_URL || DEFAULT_POISKKINO_BASE_URL;
}

function json(request, env, body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      ...corsHeaders(request, env),
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function corsHeaders(request, env) {
  const requestOrigin = request.headers.get("origin") || "";
  return {
    "access-control-allow-origin": pickAllowOrigin(requestOrigin, env.ALLOWED_ORIGIN),
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
    "vary": "Origin",
  };
}

// Decide the Access-Control-Allow-Origin value. Beyond the explicit env
// allowlist we trust any *.vercel.app (so per-commit PREVIEW deploys, whose
// subdomain hash changes every push, work without re-listing them), any
// *.alphy.tv, and localhost. This is a credential-less public resolver — CORS
// is not its security boundary (the PoiskKino token never leaves the server),
// so reflecting these origins is safe and saves constant allowlist edits.
export function pickAllowOrigin(requestOrigin, allowedCsv) {
  const allowed = (allowedCsv || "").split(",").map((item) => item.trim()).filter(Boolean);
  const trusted =
    (requestOrigin && allowed.includes(requestOrigin)) ||
    /^https:\/\/([a-z0-9-]+\.)*vercel\.app$/i.test(requestOrigin) ||
    /^https:\/\/([a-z0-9-]+\.)*alphy\.tv$/i.test(requestOrigin) ||
    /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(requestOrigin);
  if (trusted) return requestOrigin;
  return allowed[0] || "*";
}

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value || "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function enqueueZonaResolve(task) {
  const run = zonaResolveQueue.then(task, task);
  zonaResolveQueue = run.catch(() => {});
  return run;
}

// The Zona runtime drives all its network I/O through globalThis.fetch, so we
// intercept fetch to (a) capture which api.zenithjs.ws embed it resolves to and
// (b) inject the headers mzona.net requires. The naive approach — swap
// globalThis.fetch per call and restore after — leaks across calls in a
// long-lived process (Deno Deploy / Render / reused Vercel instances): getStreams
// fires background requests that keep running after we return, and they land in
// the NEXT call's capture, so every resolve returns the previous title's Zenith
// id. Cloudflare hid this only because it discards an isolate's background work
// once the response is sent. Fix: an AsyncLocalStorage store so each fetch
// attributes itself to the resolve that actually started it, no matter when it
// lands. If async_hooks is unavailable (e.g. a Cloudflare Worker without the
// flag) we fall back to the per-call swap, which is correct on ephemeral isolates.
let zonaCapture;
let zonaCaptureInstalled = false;

async function ensureZonaCapture() {
  if (zonaCapture !== undefined) return zonaCapture;
  try {
    const { AsyncLocalStorage } = await import("node:async_hooks");
    zonaCapture = new AsyncLocalStorage();
  } catch {
    zonaCapture = null;
  }
  if (zonaCapture && !zonaCaptureInstalled) {
    zonaCaptureInstalled = true;
    const realFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (input, init = {}) => {
      const store = zonaCapture.getStore();
      if (!store) return realFetch(input, init);
      return capturedFetch(realFetch, store, input, init);
    };
  }
  return zonaCapture;
}

function capturedFetch(realFetch, store, input, init = {}) {
  const targetUrl = String(input?.url || input);
  if (isZonaResolverRequest(targetUrl)) {
    store.requests.push({ method: init?.method || "GET", url: targetUrl });
  }
  const headers = new Headers(init.headers || {});
  if (/\.mzona\.net\//i.test(targetUrl)) {
    headers.set("Origin", "https://kinoserial.online");
    headers.set("Referer", "https://kinoserial.online/");
    headers.set("User-Agent", zonaUserAgent());
    headers.set("Accept", "*/*");
  }
  return realFetch(input, { ...init, headers });
}

function runZonaProvider(lib, kpId, requests, callbacks) {
  const provider = lib.createStreamsProvider({
    getStreamDurationInMicroseconds: () => "0",
  });
  // Title-level resolve only (null season/episode). For a series mzona returns
  // the whole-series Zenith embed; passing a concrete season/episode makes
  // getVideoSources come back empty and breaks series that otherwise resolve.
  provider.getStreams(Number(kpId), null, null, {
    onStreamsReceived(payload) {
      callbacks.push(parseMaybeJson(payload));
    },
    onCompletion() {},
  });
  return waitFor(() => extractZenithIds(requests).length > 0, 9000);
}

async function resolveZonaInPureJs(kpId) {
  const lib = getZonaLib();
  if (!lib?.createStreamsProvider) {
    throw new Error("Zona stream library did not expose createStreamsProvider");
  }

  const requests = [];
  const callbacks = [];
  const als = await ensureZonaCapture();
  const previousConsole = globalThis.console;
  globalThis.console = {
    ...previousConsole,
    debug() {},
    error() {},
    info() {},
    log() {},
    warn() {},
  };

  try {
    if (als) {
      await als.run({ requests, callbacks }, () => runZonaProvider(lib, kpId, requests, callbacks));
    } else {
      const previousFetch = globalThis.fetch;
      globalThis.fetch = (input, init = {}) => capturedFetch(previousFetch, { requests }, input, init);
      try {
        await runZonaProvider(lib, kpId, requests, callbacks);
      } finally {
        globalThis.fetch = previousFetch;
      }
    }
  } finally {
    globalThis.console = previousConsole;
  }

  const zenithIds = extractZenithIds(requests);
  return {
    kpId,
    zenithId: zenithIds[0] || null,
    zenithIds,
    embedUrl: zenithIds[0] ? `https://api.zenithjs.ws/embed/movie/${zenithIds[0]}` : null,
    callbacks: callbacks.map(summarizeZonaCallback),
    requests: requests.slice(0, 50),
  };
}

function isZonaResolverRequest(url) {
  return /mzona\.net|api\.zenithjs\.ws|fotpro|vibio/i.test(url);
}

function extractZenithIds(requests) {
  return [...new Set(
    requests
      .map((request) => request.url.match(/api\.zenithjs\.ws\/embed\/movie\/(\d+)/i)?.[1])
      .filter(Boolean)
  )];
}

function parseMaybeJson(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return { raw: value.slice(0, 1000) };
  }
}

function summarizeZonaCallback(value) {
  const streams = Array.isArray(value?.videoStreams) ? value.videoStreams : [];
  return {
    extractorType: value?.extractorType?.name || value?.extractorType || null,
    count: streams.length,
    streams: streams.slice(0, 5).map((stream) => ({
      url: stream?.source?.url || stream?.url || null,
      translation: stream?.translation || null,
      language: stream?.language || null,
      resolution: stream?.resolution || null,
      quality: stream?.quality || null,
      subtitles: Array.isArray(stream?.subtitles) ? stream.subtitles.length : null,
    })),
  };
}

function parseZenithEmbed(html) {
  const text = String(html || "");
  const sources = {};
  for (const match of text.matchAll(/\b(dash|dasha|hls)\s*:\s*("(?:(?:\\.|[^"\\])*)"|'(?:(?:\\.|[^'\\])*)')/g)) {
    sources[match[1]] = decodeJsQuoted(match[2]).replace(/&amp;/g, "&");
  }

  const fallbackText = text.replace(/\\\//g, "/").replace(/&amp;/g, "&");
  if (!sources.dash) sources.dash = firstUrl(fallbackText, /\.mpd(?:\?|$)/i);
  if (!sources.hls) sources.hls = firstUrl(fallbackText, /(?:\.m3u8|master\.m3u8)(?:\?|$)/i);
  const playlist = parseZenithPlaylist(text);
  const currentEpisode = findZenithEpisode(playlist.seasons, playlist.current);
  if (currentEpisode) Object.assign(sources, currentEpisode.sources);

  const titleMatch = text.match(/\btitle\s*:\s*("(?:(?:\\.|[^"\\])*)"|'(?:(?:\\.|[^'\\])*)')/);
  const audioMatch = text.match(/\baudio\s*:\s*\{\s*["']?names["']?\s*:\s*\[([^\]]*)\]/);
  return {
    sources,
    meta: {
      title: titleMatch ? decodeJsQuoted(titleMatch[1]) : "",
      audioNames: audioMatch ? [...audioMatch[1].matchAll(/"([^"]+)"|'([^']+)'/g)].map((match) => match[1] || match[2]) : [],
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
  const current = currentMatch
    ? { season: Number(currentMatch[1]), episode: Number(currentMatch[2] || currentMatch[3] || currentMatch[4]) }
    : null;
  const seasons = (Array.isArray(rawSeasons) ? rawSeasons : [])
    .map((rawSeason) => ({
      season: numberOrNull(rawSeason?.season),
      episodes: (Array.isArray(rawSeason?.episodes) ? rawSeason.episodes : [])
        .map((rawEpisode) => ({
          episode: numberOrNull(rawEpisode?.episode),
          id: numberOrNull(rawEpisode?.id),
          videoKey: numberOrNull(rawEpisode?.videoKey),
          title: String(rawEpisode?.title || "").trim(),
          sources: zenithEpisodeSources(rawEpisode),
        }))
        .filter((episode) => episode.episode > 0 && Object.keys(episode.sources).length)
        .sort((a, b) => a.episode - b.episode),
    }))
    .filter((season) => season.season > 0 && season.episodes.length)
    .sort((a, b) => a.season - b.season);
  return { current, seasons };
}

function zenithEpisodeSources(rawEpisode) {
  const sources = {};
  for (const key of ["dash", "dasha", "hls"]) {
    const value = String(rawEpisode?.[key] || "").replace(/&amp;/g, "&");
    if (/^https:\/\//i.test(value)) sources[key] = value;
  }
  return sources;
}

function findZenithEpisode(seasons, selection) {
  const season = (Array.isArray(seasons) ? seasons : []).find((item) => item.season === selection?.season);
  return season?.episodes.find((item) => item.episode === selection?.episode) || null;
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
  for (const match of String(text || "").matchAll(/https?:\/\/[^"'<>\s\\]+/g)) {
    const url = match[0].replace(/[),.;]+$/, "");
    if (kindRe.test(url)) return url;
  }
  return "";
}

function decodeJsQuoted(raw) {
  const body = String(raw || "").slice(1, -1);
  return body
    .replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\x([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\([\\/"'bfnrt])/g, (_, char) => {
      if (char === "b") return "\b";
      if (char === "f") return "\f";
      if (char === "n") return "\n";
      if (char === "r") return "\r";
      if (char === "t") return "\t";
      return char;
    });
}

async function waitFor(predicate, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}
