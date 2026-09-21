const DEFAULT_API_BASE = "https://api.srvkp.com/v1";
const DEFAULT_OAUTH_URL = "https://api.srvkp.com/oauth2/token";
const TOKEN_STATE_KEY = ["kinopub", "oauth", "v1"];
const REFRESH_SKEW_SECONDS = 300;
const REFRESH_LOCK_SECONDS = 20;
const SEARCH_TYPES = new Set([
  "all",
  "movie",
  "serial",
  "docuserial",
  "tvshow",
  "concert",
  "3d",
  "documovie",
]);

export class ResolverError extends Error {
  constructor(code, message, status = 500, details = undefined) {
    super(message);
    this.name = "ResolverError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function envValue(env, key, fallback = "") {
  const value = env?.[key];
  return value == null || value === "" ? fallback : String(value);
}

function epochSeconds(now) {
  return Math.floor(now() / 1000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseOrigins(value) {
  return new Set(
    String(value || "").split(",").map((part) => part.trim()).filter(Boolean),
  );
}

function corsHeaders(request, allowedOrigins) {
  const origin = request.headers.get("origin") || "";
  const headers = {
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
    "vary": "Origin",
  };
  if (allowedOrigins.has("*") || allowedOrigins.has(origin)) {
    headers["access-control-allow-origin"] = allowedOrigins.has("*")
      ? "*"
      : origin;
  }
  return headers;
}

function jsonResponse(request, allowedOrigins, body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      ...corsHeaders(request, allowedOrigins),
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store, private",
      "x-content-type-options": "nosniff",
    },
  });
}

function timingSafeEqual(left, right) {
  const a = new TextEncoder().encode(String(left));
  const b = new TextEncoder().encode(String(right));
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (a[index % Math.max(a.length, 1)] || 0) ^
      (b[index % Math.max(b.length, 1)] || 0);
  }
  return difference === 0;
}

function authorize(request, expectedKey) {
  if (!expectedKey) {
    throw new ResolverError(
      "resolver_not_configured",
      "Resolver access key is not configured",
      503,
    );
  }
  const authorization = request.headers.get("authorization") || "";
  const supplied = authorization.match(/^Bearer\s+(.+)$/i)?.[1] || "";
  if (!supplied || !timingSafeEqual(supplied, expectedKey)) {
    throw new ResolverError(
      "unauthorized",
      "A valid resolver bearer key is required",
      401,
    );
  }
}

function decodeBase64UrlText(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - value.length % 4) % 4);
  try {
    const binary = atob(normalized);
    const bytes = Uint8Array.from(
      binary,
      (character) => character.charCodeAt(0),
    );
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

export function decodeSignedMediaToken(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  for (const segment of parsed.pathname.split("/")) {
    if (!segment) continue;
    const decoded = decodeBase64UrlText(decodeURIComponent(segment));
    const match = decoded.match(
      /^id=([^;]+);([^;]+);([^;]+);([^;]+);(\d+)&h=([^&]+)&e=(\d+)$/,
    );
    if (!match) continue;
    return {
      accountId: match[1],
      ipUint32: match[2],
      deviceId: match[3],
      mediaId: match[4],
      issuedAt: Number(match[5]),
      expiresAt: Number(match[7]),
      ttlSeconds: Number(match[7]) - Number(match[5]),
    };
  }
  return null;
}

function qualityNumber(value) {
  const match = String(value || "").match(/\d+/);
  return match ? Number(match[0]) : 0;
}

function selectMedia(item, seasonNumber, episodeNumber) {
  if (Array.isArray(item?.videos) && item.videos.length) return item.videos[0];
  const seasons = Array.isArray(item?.seasons) ? item.seasons : [];
  if (!seasons.length) {
    throw new ResolverError(
      "media_missing",
      "The item has no playable media",
      404,
    );
  }
  const requestedSeason = seasonNumber == null
    ? seasons[0]
    : seasons.find((season) => Number(season.number) === Number(seasonNumber));
  if (!requestedSeason) {
    throw new ResolverError(
      "season_missing",
      "Requested season was not found",
      404,
    );
  }
  const episodes = Array.isArray(requestedSeason.episodes)
    ? requestedSeason.episodes
    : [];
  const requestedEpisode = episodeNumber == null
    ? episodes[0]
    : episodes.find((episode) =>
      Number(episode.number) === Number(episodeNumber)
    );
  if (!requestedEpisode) {
    throw new ResolverError(
      "episode_missing",
      "Requested episode was not found",
      404,
    );
  }
  return requestedEpisode;
}

export function selectMediaFile(item, options = {}) {
  const media = selectMedia(item, options.season, options.episode);
  const streamType = options.stream || "hls4";
  const files = (Array.isArray(media.files) ? media.files : [])
    .filter((file) => file?.url && typeof file.url[streamType] === "string")
    .sort((left, right) => {
      const pixelDifference = Number(right.w || 0) * Number(right.h || 0) -
        Number(left.w || 0) * Number(left.h || 0);
      return pixelDifference ||
        qualityNumber(right.quality) - qualityNumber(left.quality);
    });
  if (!files.length) {
    throw new ResolverError(
      "stream_missing",
      `No ${streamType} stream is available`,
      404,
    );
  }
  const requestedQuality = String(options.quality || "best").toLowerCase();
  const file = requestedQuality === "best"
    ? files[0]
    : files.find((candidate) =>
      String(candidate.quality || "").toLowerCase() === requestedQuality
    );
  if (!file) {
    throw new ResolverError(
      "quality_missing",
      `Quality ${requestedQuality} is unavailable`,
      404,
      {
        available: files.map((candidate) => candidate.quality),
      },
    );
  }
  return { media, file, streamType };
}

function initialTokenState(env, now) {
  const accessToken = envValue(env, "KINOPUB_ACCESS_TOKEN");
  const refreshToken = envValue(env, "KINOPUB_REFRESH_TOKEN");
  const configuredExpiry = Number(
    envValue(env, "KINOPUB_ACCESS_EXPIRES_AT", "0"),
  );
  return {
    accessToken,
    refreshToken,
    accessExpiresAt: Number.isFinite(configuredExpiry) ? configuredExpiry : 0,
    updatedAt: epochSeconds(now),
    refreshLock: null,
  };
}

function usableAccess(state, now, force = false) {
  return !force && Boolean(state?.accessToken) &&
    Number(state.accessExpiresAt || 0) >
      epochSeconds(now) + REFRESH_SKEW_SECONDS;
}

export function createTokenManager(
  { env, kv = null, fetchImpl = fetch, now = Date.now },
) {
  const seed = initialTokenState(env, now);
  const oauthUrl = envValue(env, "KINOPUB_OAUTH_URL", DEFAULT_OAUTH_URL);
  const clientId = envValue(env, "KINOPUB_CLIENT_ID");
  const clientSecret = envValue(env, "KINOPUB_CLIENT_SECRET");
  let memoryState = seed;
  let memoryRefresh = null;

  async function refresh(refreshToken) {
    if (!refreshToken || !clientId || !clientSecret) {
      throw new ResolverError(
        "oauth_not_configured",
        "OAuth refresh credentials are not configured",
        503,
      );
    }
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    });
    const response = await fetchImpl(oauthUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    let payload = {};
    try {
      payload = await response.json();
    } catch {
      // The normalized error below intentionally contains no credentials.
    }
    if (!response.ok || !payload.access_token || !payload.refresh_token) {
      throw new ResolverError(
        "oauth_refresh_failed",
        payload.error || `OAuth refresh failed with HTTP ${response.status}`,
        503,
      );
    }
    return {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
      accessExpiresAt: epochSeconds(now) + Number(payload.expires_in || 86400),
      updatedAt: epochSeconds(now),
      refreshLock: null,
    };
  }

  async function readOrSeedKv() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const entry = await kv.get(TOKEN_STATE_KEY);
      if (entry.value) return entry;
      if (!seed.accessToken && !seed.refreshToken) {
        throw new ResolverError(
          "oauth_not_configured",
          "OAuth seed tokens are not configured",
          503,
        );
      }
      const committed = await kv.atomic().check(entry).set(
        TOKEN_STATE_KEY,
        seed,
      ).commit();
      if (committed.ok) return await kv.get(TOKEN_STATE_KEY);
    }
    throw new ResolverError(
      "token_store_busy",
      "Unable to initialize token state",
      503,
    );
  }

  async function getFromKv(force) {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const entry = await readOrSeedKv();
      const state = entry.value;
      if (usableAccess(state, now, force)) return state.accessToken;

      const currentTime = epochSeconds(now);
      if (state.refreshLock?.until > currentTime) {
        await sleep(250);
        continue;
      }

      const lockId = crypto.randomUUID();
      const lockedState = {
        ...state,
        refreshLock: { id: lockId, until: currentTime + REFRESH_LOCK_SECONDS },
      };
      const locked = await kv.atomic().check(entry).set(
        TOKEN_STATE_KEY,
        lockedState,
      ).commit();
      if (!locked.ok) continue;

      try {
        const nextState = await refresh(state.refreshToken);
        const lockEntry = await kv.get(TOKEN_STATE_KEY);
        if (lockEntry.value?.refreshLock?.id !== lockId) continue;
        const saved = await kv.atomic().check(lockEntry).set(
          TOKEN_STATE_KEY,
          nextState,
        ).commit();
        if (!saved.ok) continue;
        return nextState.accessToken;
      } catch (error) {
        const lockEntry = await kv.get(TOKEN_STATE_KEY);
        if (lockEntry.value?.refreshLock?.id === lockId) {
          await kv.atomic().check(lockEntry).set(TOKEN_STATE_KEY, {
            ...state,
            refreshLock: null,
          }).commit().catch(() => {});
        }
        throw error;
      }
    }
    throw new ResolverError(
      "token_store_busy",
      "Timed out waiting for OAuth refresh",
      503,
    );
  }

  async function getFromMemory(force) {
    if (usableAccess(memoryState, now, force)) return memoryState.accessToken;
    if (!memoryRefresh) {
      memoryRefresh = refresh(memoryState.refreshToken)
        .then((state) => {
          memoryState = state;
          return state.accessToken;
        })
        .finally(() => {
          memoryRefresh = null;
        });
    }
    return await memoryRefresh;
  }

  return {
    persistent: Boolean(kv),
    configured: Boolean(seed.accessToken || seed.refreshToken),
    async getAccessToken({ force = false } = {}) {
      return kv ? await getFromKv(force) : await getFromMemory(force);
    },
  };
}

async function readJsonResponse(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function normalizedNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function searchItem(item) {
  const genres = Array.isArray(item?.genres) ? item.genres : [];
  const countries = Array.isArray(item?.countries) ? item.countries : [];
  return {
    id: normalizedNumber(item?.id),
    type: item?.type || null,
    subtype: item?.subtype || null,
    title: item?.title || null,
    year: normalizedNumber(item?.year),
    quality: normalizedNumber(item?.quality),
    poorQuality: Boolean(item?.poor_quality),
    duration: normalizedNumber(item?.duration),
    plot: item?.plot || null,
    poster: item?.posters?.medium || item?.posters?.small || null,
    backdrop: item?.posters?.wide || item?.posters?.big || null,
    genres: genres.map((genre) => ({
      id: normalizedNumber(genre?.id),
      title: genre?.title || null,
    })),
    countries: countries.map((country) => ({
      id: normalizedNumber(country?.id),
      title: country?.title || null,
    })),
    ratings: {
      kinopoisk: normalizedNumber(item?.kinopoisk_rating),
      imdb: normalizedNumber(item?.imdb_rating),
    },
  };
}

export function createKinoPubResolver(
  { env = {}, kv = null, fetchImpl = fetch, now = Date.now } = {},
) {
  const apiBase = envValue(env, "KINOPUB_API_BASE", DEFAULT_API_BASE).replace(
    /\/$/,
    "",
  );
  const resolverKey = envValue(env, "KINOPUB_RESOLVER_KEY");
  const allowedOrigins = parseOrigins(envValue(env, "KINOPUB_ALLOWED_ORIGINS"));
  const tokenManager = createTokenManager({ env, kv, fetchImpl, now });

  async function apiGet(path, forceRefresh = false) {
    const accessToken = await tokenManager.getAccessToken({
      force: forceRefresh,
    });
    const response = await fetchImpl(`${apiBase}/${path.replace(/^\//, "")}`, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
      },
    });
    if (response.status === 401 && !forceRefresh) {
      return await apiGet(path, true);
    }
    const payload = await readJsonResponse(response);
    if (!response.ok || !payload) {
      throw new ResolverError(
        "upstream_api_error",
        payload?.error || `KinoPub API returned HTTP ${response.status}`,
        response.status === 404 ? 404 : 502,
      );
    }
    return payload;
  }

  async function resolve(request, url) {
    authorize(request, resolverKey);
    const itemId = (url.searchParams.get("item") || "").trim();
    if (!/^\d+$/.test(itemId)) {
      throw new ResolverError(
        "invalid_item",
        "item must be a numeric item id",
        400,
      );
    }
    const stream = (url.searchParams.get("stream") || "hls4").toLowerCase();
    if (!["hls4", "hls2", "hls", "http"].includes(stream)) {
      throw new ResolverError(
        "invalid_stream",
        "stream must be hls4, hls2, hls, or http",
        400,
      );
    }
    const quality = (url.searchParams.get("quality") || "best").toLowerCase();
    const season = url.searchParams.has("season")
      ? Number(url.searchParams.get("season"))
      : null;
    const episode = url.searchParams.has("episode")
      ? Number(url.searchParams.get("episode"))
      : null;
    const payload = await apiGet(`items/${itemId}`);
    const item = payload.item;
    if (!item) {
      throw new ResolverError(
        "item_missing",
        "Item was not returned by the API",
        404,
      );
    }
    const selected = selectMediaFile(item, {
      quality,
      stream,
      season,
      episode,
    });
    const mediaUrl = selected.file.url[stream];
    const signed = decodeSignedMediaToken(mediaUrl);
    if (!signed) {
      throw new ResolverError(
        "invalid_media_url",
        "The API returned an unrecognized media URL",
        502,
      );
    }
    if (
      signed.mediaId === "-1" ||
      /\/demo(?:\/|\.)/.test(new URL(mediaUrl).pathname)
    ) {
      throw new ResolverError(
        "subscription_inactive",
        "The account is authenticated but only a demo stream is authorized",
        402,
        { subscriptionActive: false },
      );
    }
    return {
      ok: true,
      item: {
        id: Number(itemId),
        title: item.title || null,
        type: item.type || null,
      },
      media: {
        id: Number(selected.media.id || signed.mediaId),
        quality: selected.file.quality,
        codec: selected.file.codec || null,
        width: selected.file.w || null,
        height: selected.file.h || null,
        stream,
      },
      signed: {
        issuedAt: signed.issuedAt,
        expiresAt: signed.expiresAt,
        ttlSeconds: signed.ttlSeconds,
      },
      manifestUrl: mediaUrl,
    };
  }

  async function search(request, url) {
    authorize(request, resolverKey);
    const query = (url.searchParams.get("q") || "").trim().replace(/\s+/g, " ");
    const queryLength = Array.from(query).length;
    if (queryLength < 2 || queryLength > 120) {
      throw new ResolverError(
        "invalid_query",
        "q must contain between 2 and 120 characters",
        400,
      );
    }

    const type = (url.searchParams.get("type") || "all").trim().toLowerCase();
    if (!SEARCH_TYPES.has(type)) {
      throw new ResolverError(
        "invalid_type",
        `type must be one of: ${Array.from(SEARCH_TYPES).join(", ")}`,
        400,
      );
    }

    const pageText = (url.searchParams.get("page") || "1").trim();
    if (!/^\d+$/.test(pageText)) {
      throw new ResolverError(
        "invalid_page",
        "page must be a positive integer",
        400,
      );
    }
    const page = Number(pageText);
    if (!Number.isSafeInteger(page) || page < 1 || page > 1000) {
      throw new ResolverError(
        "invalid_page",
        "page must be between 1 and 1000",
        400,
      );
    }

    const upstreamParams = new URLSearchParams({
      title: query,
      page: String(page),
    });
    if (type !== "all") upstreamParams.set("type", type);
    const payload = await apiGet(`items?${upstreamParams.toString()}`);
    if (!Array.isArray(payload.items)) {
      throw new ResolverError(
        "invalid_catalog_response",
        "The catalog returned no item list",
        502,
      );
    }
    const pagination = payload.pagination || {};
    return {
      ok: true,
      query,
      type,
      items: payload.items.map(searchItem),
      pagination: {
        current: normalizedNumber(pagination.current) || page,
        total: normalizedNumber(pagination.total) || 0,
        perPage: normalizedNumber(pagination.perpage) || payload.items.length,
        totalItems: normalizedNumber(pagination.total_items) || 0,
      },
    };
  }

  return async function handler(request) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request, allowedOrigins),
      });
    }
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse(request, allowedOrigins, {
          ok: true,
          service: "kinopub-direct-resolver",
          oauthConfigured: tokenManager.configured,
          persistentTokenStore: tokenManager.persistent,
          proxiesVideoBytes: false,
        });
      }
      if (request.method === "GET" && url.pathname === "/v1/kinopub/resolve") {
        return jsonResponse(
          request,
          allowedOrigins,
          await resolve(request, url),
        );
      }
      if (request.method === "GET" && url.pathname === "/v1/kinopub/search") {
        return jsonResponse(
          request,
          allowedOrigins,
          await search(request, url),
        );
      }
      return jsonResponse(request, allowedOrigins, {
        ok: false,
        error: "not_found",
      }, 404);
    } catch (error) {
      const normalized = error instanceof ResolverError
        ? error
        : new ResolverError("internal_error", "Unexpected resolver error", 500);
      const response = jsonResponse(request, allowedOrigins, {
        ok: false,
        error: normalized.code,
        message: normalized.message,
        ...(normalized.details ? { details: normalized.details } : {}),
      }, normalized.status);
      if (normalized.status === 401) {
        response.headers.set("www-authenticate", "Bearer");
      }
      return response;
    }
  };
}
