import { readDocument, writeDocument } from "./_document-store.js";

const MAX_LISTS = 24;
const MAX_ITEMS_PER_LIST = 60;
const MAX_BODY_BYTES = 512 * 1024;
const ITEM_LABEL_MAX = 32;
const DEFAULT_BANNER_TEXT = "Добавьте сайт в закладки";

export function emptyCatalog() {
  return {
    schema: 1,
    revision: 0,
    updatedAt: null,
    forYou: "on",
    bookmarkBanner: false,
    bookmarkBannerText: DEFAULT_BANNER_TEXT,
    lists: [],
  };
}

// «Для вас» kill-switch distributed to all clients via the public envelope:
// "on" (default) | "frozen" (clients render caches, no API calls) | "off".
export function normalizeForYouMode(value) {
  return value === "frozen" || value === "off" ? value : "on";
}

function text(value, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}

function positiveNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function positiveIntegerText(value) {
  const textValue = text(value, 40);
  return /^\d+$/.test(textValue) ? textValue : "";
}

function normalizePersonRefs(value, limit) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const person of value) {
    const id = positiveIntegerText(person?.id || person?.staffId);
    const name = text(person?.name || person?.nameRu || person?.nameEn, 160);
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name });
    if (out.length >= limit) break;
  }
  return out;
}

function normalizeExternalId(value) {
  const imdb = text(value?.imdb || value?.imdbId, 40);
  const tmdb = positiveIntegerText(value?.tmdb || value?.tmdbId);
  const externalId = {};
  if (/^tt\d{5,}$/i.test(imdb)) externalId.imdb = imdb;
  if (tmdb) externalId.tmdb = tmdb;
  return Object.keys(externalId).length ? externalId : null;
}

function publicHttpsUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:") return "";
    url.username = "";
    url.password = "";
    return url.href.slice(0, 3000);
  } catch {
    return "";
  }
}

function normalizeTarget(value) {
  const kind = text(value?.kind, 12);
  if (kind === "zen" && /^\d+$/.test(String(value?.zenithId || ""))) {
    return { kind, zenithId: String(value.zenithId) };
  }
  if (kind === "kp" && /^\d+$/.test(String(value?.kpId || ""))) {
    return { kind, kpId: String(value.kpId) };
  }
  if (kind === "ort") {
    const embedUrl = publicHttpsUrl(value?.embedUrl);
    if (/^https:\/\/api\.ortified\.ws\/embed\//i.test(embedUrl)) return { kind, embedUrl };
  }
  if (kind === "opr") {
    const playerUrl = publicHttpsUrl(value?.playerUrl);
    const pageUrl = publicHttpsUrl(value?.pageUrl);
    if (/^https:\/\/(?:gencit\.info|opravar\.online)\/bil\/\d+/i.test(playerUrl)) {
      return { kind, playerUrl, ...(pageUrl ? { pageUrl } : {}) };
    }
  }
  if (kind === "nd") {
    const pageUrl = publicHttpsUrl(value?.pageUrl);
    if (/(^|\.)newdeaf\.co\//i.test(pageUrl)) return { kind, pageUrl };
  }
  if (kind === "soap" && /^\d+$/.test(String(value?.soapId || ""))) {
    return { kind, soapId: String(value.soapId) };
  }
  if (kind === "rezka" && /^\d+$/.test(String(value?.rezkaId || ""))) {
    const target = { kind, rezkaId: String(value.rezkaId) };
    if (/^\d+$/.test(String(value?.kpId || ""))) target.kpId = String(value.kpId);
    return target;
  }
  // Must stay in step with the same list in catalog.js: a kind missing from
  // either one is dropped, and the LiftW gap meant an admin could add a title,
  // see nothing happen, and have no idea which half rejected it.
  if (kind === "lift" && /^\d+$/.test(String(value?.liftId || ""))) {
    const target = { kind, liftId: String(value.liftId) };
    const season = positiveIntegerText(value?.season);
    const episode = positiveIntegerText(value?.episode);
    if (season) target.season = Number(season);
    if (episode) target.episode = Number(episode);
    if (/^\d+$/.test(String(value?.kpId || ""))) target.kpId = String(value.kpId);
    return target;
  }
  if (kind === "clps" && /^\d+$/.test(String(value?.kpId || ""))) {
    const target = { kind, kpId: String(value.kpId) };
    const season = positiveIntegerText(value?.season);
    const episode = positiveIntegerText(value?.episode);
    if (season) target.season = Number(season);
    if (episode) target.episode = Number(episode);
    return target;
  }
  return null;
}

function normalizeItem(value) {
  const target = normalizeTarget(value?.target);
  if (!target) return null;
  const title = text(value?.title, 220);
  if (!title) return null;
  const key = text(value?.key, 300) || JSON.stringify(target);
  const poster = publicHttpsUrl(value?.poster);
  const backdrop = publicHttpsUrl(value?.backdrop);
  const label = text(value?.label, ITEM_LABEL_MAX).replace(/\s+/g, " ");
  const externalId = normalizeExternalId(value?.externalId || value?.externalIds);
  const ageRating = positiveNumber(value?.ageRating);
  const ratingMpaa = text(value?.ratingMpaa, 16);
  const people = {
    directors: normalizePersonRefs(value?.people?.directors, 3),
    cast: normalizePersonRefs(value?.people?.cast, 8),
  };
  const item = {
    id: text(value?.id, 80) || crypto.randomUUID(),
    key,
    title,
    year: text(value?.year, 12),
    poster,
    backdrop,
    description: text(value?.description, 3000),
    label,
    isSeries: !!value?.isSeries,
    movieLength: positiveNumber(value?.movieLength),
    rating: {
      kp: positiveNumber(value?.rating?.kp),
      imdb: positiveNumber(value?.rating?.imdb),
    },
    ...(externalId ? { externalId } : {}),
    ...(ageRating != null ? { ageRating } : {}),
    ...(ratingMpaa ? { ratingMpaa } : {}),
    ...((people.directors.length || people.cast.length) ? { people } : {}),
    target,
    cachedAt: text(value?.cachedAt, 40) || new Date().toISOString(),
  };
  if (!item.poster) delete item.poster;
  if (!item.backdrop) delete item.backdrop;
  if (!item.description) delete item.description;
  if (!item.label) delete item.label;
  if (!item.year) delete item.year;
  if (item.movieLength == null) delete item.movieLength;
  if (item.rating.kp == null) delete item.rating.kp;
  if (item.rating.imdb == null) delete item.rating.imdb;
  return item;
}

export function normalizeCatalog(value, { nextRevision = null } = {}) {
  const seenIds = new Set();
  const lists = [];
  for (const rawList of Array.isArray(value?.lists) ? value.lists.slice(0, MAX_LISTS) : []) {
    const title = text(rawList?.title, 120) || "Новый список";
    let id = text(rawList?.id, 80) || crypto.randomUUID();
    if (seenIds.has(id)) id = crypto.randomUUID();
    seenIds.add(id);
    const itemKeys = new Set();
    const items = [];
    for (const rawItem of Array.isArray(rawList?.items) ? rawList.items.slice(0, MAX_ITEMS_PER_LIST) : []) {
      const item = normalizeItem(rawItem);
      if (!item || itemKeys.has(item.key)) continue;
      itemKeys.add(item.key);
      items.push(item);
    }
    lists.push({ id, title, items });
  }
  const revisionValue = nextRevision == null ? Number(value?.revision) : nextRevision;
  return {
    schema: 1,
    revision: Number.isInteger(revisionValue) && revisionValue >= 0 ? revisionValue : 0,
    updatedAt: text(value?.updatedAt, 40) || null,
    forYou: normalizeForYouMode(value?.forYou),
    bookmarkBanner: value?.bookmarkBanner === true,
    bookmarkBannerText: text(value?.bookmarkBannerText, 120) || DEFAULT_BANNER_TEXT,
    lists,
  };
}

export async function readCatalog() {
  const document = await readDocument("catalog");
  if (!document?.payload) throw new Error("catalog_not_migrated");
  return { catalog: normalizeCatalog(document.payload) };
}

export async function writeCatalog(rawCatalog, expectedRevision) {
  const current = await readCatalog();
  if (Number.isInteger(expectedRevision) && expectedRevision !== current.catalog.revision) {
    const error = new Error("catalog_revision_conflict");
    error.code = error.message; error.current = current; throw error;
  }
  const catalog = normalizeCatalog(rawCatalog, { nextRevision: current.catalog.revision + 1 });
  catalog.updatedAt = new Date().toISOString();
  if (Buffer.byteLength(JSON.stringify(catalog), "utf8") > MAX_BODY_BYTES) {
    const error = new Error("catalog_too_large"); error.code = error.message; throw error;
  }
  try { await writeDocument("catalog", catalog, current.catalog.revision, catalog.revision); }
  catch (error) {
    if (error.code === "catalog_revision_conflict") error.current = { catalog: error.document };
    throw error;
  }
  return { catalog };
}
