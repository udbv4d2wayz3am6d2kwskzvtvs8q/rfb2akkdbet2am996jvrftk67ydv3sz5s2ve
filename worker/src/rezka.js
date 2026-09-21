// HDRezka anonymous resolver — the LAST-RESORT source.
//
// Runs on both Cloudflare Workers and Deno Deploy, so it uses only web-standard
// APIs (fetch/URL/URLSearchParams/atob/TextDecoder/AbortSignal) — no node:Buffer.
//
// What is reachable anonymously (verified 2026-07-12/13 against hdrzk.org with the
// official Android app headers):
//   - GET /            -> anonymous session cookies (PHPSESSID + dle tokens)
//   - GET /search/      -> catalogue search (title -> rezkaId)
//   - POST /ajax/get_cdn_series/ (action=get_movie / get_stream)
//        -> a PlayerJS stream string with distinct full-film MP4s for 360/480/720
//           plus a `subtitle` PlayerJS string and `subtitle_lns` code map.
// 1080p and up are server-gated (registered `null` / premium 60s sample) and are
// NEVER surfaced as playable. The signed Voidboost MP4/VTT URLs are short-lived,
// so this endpoint is no-store and the browser re-resolves on expiry.
//
// The film HTML page (which carries the translator/dub list) is WAF-gated
// (ddos-guard 403) from datacenter IPs, so audio-track enumeration is best-effort:
// when it is blocked we return only the single resolved dub and no switcher.

const DEFAULT_REZKA_BASE = "https://hdrzk.org/";
const APP_VERSION = "2.2.5";
// The common Russian dubs, tried in order until one returns a real stream. This is
// only the *fallback* order when no explicit translator is requested and the film
// page (the authoritative dub list) is unreachable.
export const DEFAULT_TRANSLATORS = [56, 238, 1, 111];
const USER_AGENT = [
  "Mozilla/5.0 (Linux; Android 14; Pixel 7)",
  "AppleWebKit/537.36 (KHTML, like Gecko)",
  "Chrome/120.0.0.0 Safari/537.36",
].join(" ");

// Subtitle-language label -> BCP47-ish code, as a fallback when the server's own
// subtitle_lns map does not carry the code.
const SUB_LANG_GUESS = {
  "русский": "ru",
  "russian": "ru",
  "english": "en",
  "английский": "en",
  "украинский": "uk",
  "ukrainian": "uk",
};

function base64ToUtf8(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function decodeHtml(value = "") {
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

export function stripTags(value = "") {
  return decodeHtml(value.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

export function normalizeTitle(value = "") {
  return value
    .toLocaleLowerCase("ru")
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function parseTitleYear(titleName) {
  const value = String(titleName || "").trim();
  const match = value.match(/^(.*?)(?:\s*\((\d{4})\))?$/);
  return {
    title: (match?.[1] || value).trim(),
    year: match?.[2] ? Number(match[2]) : null,
  };
}

export function parseSearchResults(html) {
  const items = [];
  const pattern = /<div class="b-content__inline_item"[^>]*data-id="(\d+)".*?<div class="b-content__inline_item-link">.*?<a href="([^"]+)"[^>]*>(.*?)<\/a>.*?<div>(.*?)<\/div>/gms;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    const misc = stripTags(match[4]);
    const yearMatch = misc.match(/(?:^|\D)((?:19|20)\d{2})(?:\D|$)/);
    items.push({
      rezkaId: Number(match[1]),
      url: decodeHtml(match[2]),
      title: stripTags(match[3]),
      year: yearMatch ? Number(yearMatch[1]) : null,
      misc,
    });
  }
  return items;
}

export function decodeStreamString(streams) {
  const value = String(streams || "");
  if (!value.startsWith("#h")) return value;
  let encoded = value.slice(2);
  for (let index = 0; index < 20; index += 1) {
    const marker = encoded.indexOf("//_//");
    if (marker < 0) break;
    encoded = encoded.slice(0, marker) + encoded.slice(marker + 21);
  }
  return base64ToUtf8(encoded);
}

function qualityNumber(label) {
  const value = String(label).match(/(\d{3,4})/);
  return value ? Number(value[1]) : 0;
}

export function parseStreams(value) {
  const decoded = decodeStreamString(String(value || ""));
  return decoded.split(/,(?=\[)/).map((entry) => {
    const close = entry.indexOf("]");
    if (!entry.startsWith("[") || close < 0) return null;
    const rawLabel = entry.slice(1, close);
    const url = entry.slice(close + 1).trim();
    const gate = rawLabel.includes("pjs-prem-quality")
      ? "premium"
      : rawLabel.includes("pjs-registered-quality")
        ? "registered"
        : "anonymous";
    const hasHttpUrl = /^https?:\/\//.test(url);
    const available = gate === "anonymous" && hasHttpUrl;
    return {
      label: stripTags(rawLabel),
      quality: qualityNumber(stripTags(rawLabel)),
      gate,
      available,
      url: available ? url : null,
    };
  }).filter(Boolean);
}

// The get_movie/get_stream response carries subtitles as a PlayerJS string, e.g.
// "[Русский]https://.../rus.vtt,[English]https://.../eng.vtt". subtitle_lns maps
// the visible label to a language code; subtitle_def names the default.
export function parseSubtitles(subtitle, subtitleLns = {}, subtitleDef = "") {
  if (!subtitle || typeof subtitle !== "string") return [];
  const codeMap = subtitleLns && typeof subtitleLns === "object" ? subtitleLns : {};
  return subtitle.split(/,(?=\[)/).map((entry) => {
    const close = entry.indexOf("]");
    if (!entry.startsWith("[") || close < 0) return null;
    const label = stripTags(entry.slice(1, close));
    const url = entry.slice(close + 1).trim();
    if (!/^https?:\/\//.test(url)) return null;
    const lang = codeMap[label] || SUB_LANG_GUESS[label.toLowerCase()] || "";
    return { lang, label, url, default: !!(subtitleDef && lang && String(subtitleDef) === lang) };
  }).filter(Boolean);
}

// Dubs (audio tracks) live in the film page's <ul id="translators-list">. Each
// <li data-translator_id> is a separate MP4 set — switching a dub means resolving
// again with that translator_id. Best-effort: the page 403s from datacenter IPs.
export function parseTranslators(html) {
  const list = String(html || "").match(/<ul[^>]*id=["']translators-list["'][\s\S]*?<\/ul>/i);
  if (!list) return [];
  return [...list[0].matchAll(/<li\b([^>]*?)data-translator_id=["'](\d+)["']([^>]*)>([\s\S]*?)<\/li>/gi)].map((m) => {
    const attrs = `${m[1]} ${m[3]}`;
    return {
      id: Number(m[2]),
      name: stripTags(m[4]),
      camrip: /data-camrip=["']1["']/.test(attrs) ? 1 : 0,
      director: /data-director=["']1["']/.test(attrs) ? 1 : 0,
      ads: /data-ads=["']1["']/.test(attrs) ? 1 : 0,
    };
  }).filter((t) => Number.isFinite(t.id));
}

export function chooseSearchResult(results, wantedTitle, wantedYear) {
  const normalizedWanted = normalizeTitle(wantedTitle);
  if (!normalizedWanted) return null;
  const exact = results.filter((item) => normalizeTitle(item.title) === normalizedWanted);
  if (!exact.length) return null;
  const year = Number(wantedYear);
  if (Number.isFinite(year) && year > 0) {
    const sameYear = exact.filter((item) => Number(item.year) === year);
    // A known but different year is a remake, not an acceptable fuzzy fallback.
    if (!sameYear.length) return exact.length === 1 && !exact[0].year ? exact[0] : null;
    return sameYear.sort((a, b) => a.rezkaId - b.rezkaId)[0];
  }
  // Without a year, duplicate exact titles are ambiguous. Fail closed instead of
  // silently opening whichever remake happened to sort first.
  return exact.length === 1 ? exact[0] : null;
}

function cookiePairs(headers) {
  const values = typeof headers.getSetCookie === "function"
    ? headers.getSetCookie()
    : [headers.get("set-cookie")].filter(Boolean);
  return values.map((value) => value.split(";", 1)[0]).filter((value) => {
    const [, cookieValue = ""] = value.split("=", 2);
    return cookieValue && cookieValue !== "deleted";
  });
}

export class RezkaClient {
  constructor({
    baseUrl = DEFAULT_REZKA_BASE,
    fetchImpl = globalThis.fetch,
    translators = DEFAULT_TRANSLATORS,
    timeoutMs = 12000,
    clientIp = "",
  } = {}) {
    if (!fetchImpl) throw new Error("A fetch implementation is required");
    this.baseUrl = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
    // workerd's native fetch is an Web IDL function and rejects a method-style
    // call (`this.fetch(...)`) with "Illegal invocation". Keep a plain closure so
    // the same client works in Cloudflare Workers, Deno, Node tests, and browsers.
    this.fetch = (...args) => fetchImpl(...args);
    this.translators = translators;
    this.timeoutMs = timeoutMs;
    const firstIp = String(clientIp || "").split(",", 1)[0].trim();
    // Deno Deploy exposes IPv4 clients through remoteAddr as ::ffff:a.b.c.d.
    // Rezka signs the literal header value, while the CDN later sees plain IPv4,
    // so preserving the mapped form makes every otherwise-valid URL return 404.
    const normalizedIp = firstIp.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i)?.[1] || firstIp;
    this.clientIp = normalizedIp.length <= 45 && /^[0-9a-f:.]+$/i.test(normalizedIp) ? normalizedIp : "";
    this.cookies = [];
  }

  appHeaders(extra = {}) {
    return {
      "User-Agent": USER_AGENT,
      "X-Hdrezka-Android-App": "1",
      "X-Hdrezka-Android-App-Version": APP_VERSION,
      // Voidboost validates signed URLs against the viewer IP. Cloudflare gives
      // us that address inbound; forwarding it lets the MP4 bypass the Worker.
      ...(this.clientIp ? { "CF-Connecting-IP": this.clientIp } : {}),
      ...extra,
    };
  }

  fetchWithTimeout(url, options = {}) {
    return this.fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(this.timeoutMs),
      ...options,
    });
  }

  async bootstrap() {
    if (this.cookies.length) return;
    const response = await this.fetchWithTimeout(this.baseUrl, { headers: this.appHeaders() });
    if (!response.ok) throw new Error(`Rezka bootstrap failed: HTTP ${response.status}`);
    this.cookies = cookiePairs(response.headers);
  }

  cookieHeader() {
    return [
      ...this.cookies,
      "allowed_comments=1",
      "_ym_isad=1",
      "_ym_visorc=b",
      "dle_newpm=0",
    ].join("; ");
  }

  async search(query) {
    if (!String(query || "").trim()) throw new Error("Search query is required");
    await this.bootstrap();
    const url = new URL("search/", this.baseUrl);
    url.searchParams.set("do", "search");
    url.searchParams.set("subaction", "search");
    url.searchParams.set("q", String(query).trim());
    const response = await this.fetchWithTimeout(url, {
      headers: this.appHeaders({ Cookie: this.cookieHeader() }),
    });
    if (!response.ok) throw new Error(`Rezka search failed: HTTP ${response.status}`);
    return parseSearchResults(await response.text());
  }

  // Best-effort dub list from the film page. Never throws — a WAF 403 just means
  // "no switcher available", it must not fail the whole resolve.
  async fetchTranslators(movieUrl) {
    if (!movieUrl) return [];
    try {
      const response = await this.fetchWithTimeout(movieUrl, {
        headers: this.appHeaders({ Cookie: this.cookieHeader(), Referer: this.baseUrl.toString() }),
      });
      if (!response.ok) return [];
      return parseTranslators(await response.text());
    } catch {
      return [];
    }
  }

  // Resolve one translator's streams + subtitles. If translatorId is given, only
  // that dub is tried; otherwise the fallback list is tried until one yields a
  // real anonymous stream.
  async resolveMovieById(rezkaId, translatorId = null) {
    await this.bootstrap();
    const candidates = translatorId ? [Number(translatorId)] : this.translators;
    const failures = [];
    for (const candidate of candidates) {
      const endpoint = new URL("ajax/get_cdn_series/", this.baseUrl);
      endpoint.searchParams.set("t", String(Date.now()));
      const form = new URLSearchParams({
        id: String(rezkaId),
        translator_id: String(candidate),
        is_camrip: "0",
        is_ads: "0",
        is_director: "0",
        action: "get_movie",
      });
      let response;
      try {
        response = await this.fetchWithTimeout(endpoint, {
          method: "POST",
          headers: this.appHeaders({
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
            Cookie: this.cookieHeader(),
            Referer: this.baseUrl.toString(),
          }),
          body: form,
        });
      } catch (error) {
        failures.push(`${candidate}: ${error.message}`);
        continue;
      }
      if (!response.ok) {
        failures.push(`${candidate}: HTTP ${response.status}`);
        continue;
      }
      let json;
      try {
        json = await response.json();
      } catch {
        failures.push(`${candidate}: invalid JSON`);
        continue;
      }
      if (!json.success) {
        failures.push(`${candidate}: ${stripTags(json.message || "resolver rejected request")}`);
        continue;
      }
      const streams = parseStreams(json.url);
      const playable = streams
        .filter((stream) => stream.available)
        .sort((left, right) => right.quality - left.quality);
      if (!playable.length) {
        failures.push(`${candidate}: no anonymous stream`);
        continue;
      }
      return {
        translatorId: candidate,
        streams,
        playable,
        subtitles: parseSubtitles(json.subtitle, json.subtitle_lns, json.subtitle_def),
        locked: streams.filter((stream) => !stream.available),
        best: playable[0] || null,
      };
    }
    throw new Error(`No working translator for Rezka ID ${rezkaId}: ${failures.join("; ")}`);
  }

  async resolve({
    kpId = null, title = null, year = null, rezkaId = null,
    translatorId = null, withTranslators = false,
  } = {}) {
    let lookup = null;
    let movie = null;
    if (rezkaId) {
      movie = { rezkaId: Number(rezkaId), title: title || null, year: year ? Number(year) : null, url: null };
    } else if (title) {
      // Title+year is the fast path: no KinoPoisk->title lookup needed.
      lookup = { kpId: kpId ? Number(kpId) : null, title: String(title).trim(), year: year ? Number(year) : null };
    } else {
      // A bare kpId used to be turned into a title by asking Collaps for it. That
      // was the only place this backend spoke to a source directly, and it undid
      // the point of the viewer-side sandbox: Collaps saw one datacenter IP, with
      // one fixed User-Agent, once per Rezka resolve — a far better correlation
      // handle than anything the browser path leaks. Rezka is searched by title
      // regardless, and every caller that matters already holds one, so the lookup
      // is deleted rather than moved to another host.
      throw new Error("Provide title (with optional year) or a Rezka id");
    }
    if (!movie) {
      const results = await this.search(lookup.title);
      movie = chooseSearchResult(results, lookup.title, lookup.year);
      if (!movie) throw new Error(`Rezka title not found: ${lookup.title}`);
    }
    const resolved = await this.resolveMovieById(movie.rezkaId, translatorId);
    let translators = [];
    if (withTranslators && movie.url) {
      translators = await this.fetchTranslators(movie.url);
    }
    return {
      query: {
        kpId: lookup?.kpId ?? (kpId ? Number(kpId) : null),
        title: lookup?.title ?? title ?? null,
        year: lookup?.year ?? (year ? Number(year) : null),
      },
      movie,
      translators,
      ...resolved,
    };
  }
}
