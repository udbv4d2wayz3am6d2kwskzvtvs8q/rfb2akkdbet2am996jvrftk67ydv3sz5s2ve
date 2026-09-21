import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCatalog } from "../api/_catalog-store.js";

test("normalizes direct player targets and metadata", () => {
  const catalog = normalizeCatalog({
    revision: 7,
    lists: [{
      id: "featured",
      title: "  Выбор редакции ",
      items: [{
        id: "bojack",
        key: "zen:2097",
        title: " Конь БоДжек ",
        year: 2014,
        poster: "https://example.com/poster.jpg",
        label: "  Новый   сезон  ",
        rating: { kp: "8.4", imdb: 8.8 },
        externalId: { imdb: "tt3398228", tmdb: 61222 },
        ageRating: 16,
        ratingMpaa: "tv-ma",
        people: {
          directors: [{ id: 123, name: "Рафаэль Боб-Ваксберг" }],
          cast: [{ id: 456, name: "Уилл Арнетт" }],
        },
        isSeries: true,
        target: { kind: "zen", zenithId: 2097 },
      }],
    }],
  });

  assert.equal(catalog.revision, 7);
  assert.equal(catalog.lists[0].title, "Выбор редакции");
  assert.deepEqual(catalog.lists[0].items[0].target, { kind: "zen", zenithId: "2097" });
  assert.equal(catalog.lists[0].items[0].label, "Новый сезон");
  assert.deepEqual(catalog.lists[0].items[0].rating, { kp: 8.4, imdb: 8.8 });
  assert.deepEqual(catalog.lists[0].items[0].externalId, { imdb: "tt3398228", tmdb: "61222" });
  assert.equal(catalog.lists[0].items[0].ageRating, 16);
  assert.equal(catalog.lists[0].items[0].ratingMpaa, "tv-ma");
  assert.deepEqual(catalog.lists[0].items[0].people, {
    directors: [{ id: "123", name: "Рафаэль Боб-Ваксберг" }],
    cast: [{ id: "456", name: "Уилл Арнетт" }],
  });
});

test("does not turn missing numeric metadata into zero", () => {
  const catalog = normalizeCatalog({
    lists: [{ title: "x", items: [{
      title: "Без рейтинга",
      ageRating: null,
      movieLength: null,
      rating: { kp: null, imdb: null },
      target: { kind: "kp", kpId: "301" },
    }] }],
  });
  const item = catalog.lists[0].items[0];
  assert.equal("ageRating" in item, false);
  assert.equal("movieLength" in item, false);
  assert.deepEqual(item.rating, {});
});

test("normalizes persistent soap, Collaps, and Rezka targets", () => {
  const catalog = normalizeCatalog({
    lists: [{
      id: "players",
      title: "Players",
      items: [
        {
          key: "soap:123",
          title: "Soap Movie",
          target: { kind: "soap", soapId: 123 },
        },
        {
          key: "clps:404900",
          title: "Breaking Bad",
          isSeries: true,
          target: { kind: "clps", kpId: 404900, season: "1", episode: "1" },
        },
        {
          key: "rezka:657",
          title: "Pacific Rim",
          target: { kind: "rezka", rezkaId: 657, kpId: 1234 },
        },
      ],
    }],
  });

  assert.deepEqual(catalog.lists[0].items[0].target, { kind: "soap", soapId: "123" });
  assert.deepEqual(catalog.lists[0].items[1].target, { kind: "clps", kpId: "404900", season: 1, episode: 1 });
  assert.deepEqual(catalog.lists[0].items[2].target, { kind: "rezka", rezkaId: "657", kpId: "1234" });
});

test("rejects invalid targets, duplicate keys and non-https artwork", () => {
  const catalog = normalizeCatalog({
    lists: [{
      id: "one",
      title: "One",
      items: [
        { key: "x", title: "Bad", target: { kind: "zen", zenithId: "nope" } },
        { key: "same", title: "First", poster: "http://example.com/a.jpg", target: { kind: "kp", kpId: "42" } },
        { key: "same", title: "Duplicate", target: { kind: "kp", kpId: "42" } },
      ],
    }],
  });

  assert.equal(catalog.lists[0].items.length, 1);
  assert.equal(catalog.lists[0].items[0].title, "First");
  assert.equal("poster" in catalog.lists[0].items[0], false);
});

test("caps list and item counts", () => {
  const rawLists = Array.from({ length: 30 }, (_, listIndex) => ({
    id: `list-${listIndex}`,
    title: `List ${listIndex}`,
    items: Array.from({ length: 70 }, (_, itemIndex) => ({
      key: `kp:${listIndex}:${itemIndex}`,
      title: `Item ${itemIndex}`,
      target: { kind: "kp", kpId: String(1000 + itemIndex) },
    })),
  }));
  const catalog = normalizeCatalog({ lists: rawLists });
  assert.equal(catalog.lists.length, 24);
  assert.equal(catalog.lists[0].items.length, 60);
});

test("forYou mode survives normalization and defaults to on", () => {
  assert.equal(normalizeCatalog({ lists: [] }).forYou, "on");
  assert.equal(normalizeCatalog({ forYou: "frozen", lists: [] }).forYou, "frozen");
  assert.equal(normalizeCatalog({ forYou: "off", lists: [] }).forYou, "off");
  assert.equal(normalizeCatalog({ forYou: "junk", lists: [] }).forYou, "on");
});

test("bookmark banner is an explicit catalog boolean", () => {
  const defaults = normalizeCatalog({ lists: [] });
  assert.equal(defaults.bookmarkBanner, false);
  assert.equal(defaults.bookmarkBannerText, "Добавьте сайт в закладки");
  const enabled = normalizeCatalog({
    bookmarkBanner: true,
    bookmarkBannerText: "  Важное объявление  ",
    lists: [],
  });
  assert.equal(enabled.bookmarkBanner, true);
  assert.equal(enabled.bookmarkBannerText, "Важное объявление");
  assert.equal(normalizeCatalog({ bookmarkBanner: "true", lists: [] }).bookmarkBanner, false);
});

test("a LiftW title survives both validators, and the two lists agree on kinds", async () => {
  const { readFile } = await import("node:fs/promises");
  const catalog = normalizeCatalog({
    lists: [{
      title: "LiftW",
      items: [{
        title: "Нормальные люди",
        year: 2020,
        isSeries: true,
        target: { kind: "lift", liftId: 15859, season: 1, episode: 2, kpId: "1301155" },
      }],
    }],
  });
  // The whole bug in one assertion: an unknown kind makes normalizeTarget return
  // null, normalizeItem drop the item, and the add button do nothing at all.
  assert.equal(catalog.lists[0].items.length, 1, "a LiftW title must not be dropped on save");
  assert.deepEqual(catalog.lists[0].items[0].target, {
    kind: "lift", liftId: "15859", season: 1, episode: 2, kpId: "1301155",
  });
  assert.equal(normalizeCatalog({ lists: [{ items: [{ title: "x", target: { kind: "lift" } }] }] })
    .lists[0].items.length, 0, "a lift target without an id must still be refused");

  // The accepted kinds are declared twice — once here, once in catalog.js — and
  // a kind added to only one silently loses items on the other side. Neither
  // copy is authoritative, so the test is that they match.
  const kindsOf = (source) => new Set([...source.matchAll(/kind === "(\w+)"/g)].map((m) => m[1]));
  const server = kindsOf(await readFile(new URL("../api/_catalog-store.js", import.meta.url), "utf8"));
  const client = kindsOf(await readFile(new URL("../catalog.js", import.meta.url), "utf8"));
  assert.deepEqual([...server].sort(), [...client].sort(),
    "catalog.js and api/_catalog-store.js must accept the same target kinds");
});
