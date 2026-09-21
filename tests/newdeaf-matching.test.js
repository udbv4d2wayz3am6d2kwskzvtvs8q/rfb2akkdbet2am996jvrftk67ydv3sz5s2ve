import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { makeSandbox } from "./helpers/app-sandbox.js";

function matcherApi() {
  const ctx = makeSandbox();
  ctx.run();
  return ctx.sandbox.window.alphyBridge._test;
}

test("Newdeaf metadata enrichment never treats a longer Batman title as Batman", () => {
  const { matchNewdeafMetadata } = matcherApi();
  const batman = {
    kpId: "590286",
    name: "Бэтмен",
    year: 2022,
    isSeries: false,
    poster: "https://posters/590286.jpg",
  };
  const lego = {
    kpId: "837479",
    name: "Лего Фильм: Бэтмен",
    year: 2017,
    isSeries: false,
    poster: "https://posters/837479.jpg",
  };

  assert.equal(matchNewdeafMetadata({
    title: "Лего Фильм: Бэтмен (2017) - русские субтитры",
    url: "https://22jul.newdeaf.co/multfilm/921-lego-film-bjetmen-2017-subtitry.html",
  }, [batman]), null);
  assert.equal(matchNewdeafMetadata({
    title: "Лего Фильм: Бэтмен (2017) - русские субтитры",
    url: "https://22jul.newdeaf.co/multfilm/921-lego-film-bjetmen-2017-subtitry.html",
  }, [batman, lego])?.kpId, "837479");
});

test("Newdeaf exact matching uses year and page type to avoid remakes", () => {
  const { matchNewdeafMetadata } = matcherApi();
  const movies = [
    { kpId: "4205", name: "Бэтмен", year: 1989, isSeries: false },
    { kpId: "590286", name: "Бэтмен", year: 2022, isSeries: false },
    { kpId: "series", name: "Бэтмен", year: 2022, isSeries: true },
  ];
  const match = matchNewdeafMetadata({
    title: "Бэтмен (2022) - русские субтитры",
    url: "https://22jul.newdeaf.co/film/5829-bjetmen-2022-subtitry.html",
  }, movies);
  assert.equal(match?.kpId, "590286");
});

test("recommendation matching is exact and prefers the first Newdeaf season", () => {
  const { pickExactNewdeafResult, newdeafPageType, cleanNewdeafTitle } = matcherApi();
  const season2 = {
    title: "Бэтмен будущего (2 сезон) - русские субтитры",
    url: "https://22jul.newdeaf.co/multfilm/8032-bjetmen-buduschego-2-sezon-subtitry.html",
  };
  const season1 = {
    title: "Бэтмен будущего (1 сезон) - русские субтитры",
    url: "https://22jul.newdeaf.co/multfilm/8031-bjetmen-buduschego-1-sezon-subtitry.html",
  };
  const unrelated = {
    title: "Новые приключения Бэтмена (1 сезон) - русские субтитры",
    url: "https://22jul.newdeaf.co/multfilm/7438-novye-prikljuchenija-bjetmena-1-sezon-subtitry.html",
  };

  const picked = pickExactNewdeafResult([season2, unrelated, season1], {
    title: "Бэтмен будущего",
    year: "1999",
    isSeries: true,
  });
  assert.equal(picked?.url, season1.url);
  assert.equal(newdeafPageType(season1), true);
  assert.equal(newdeafPageType({
    title: "Бэтмен (2022)",
    url: "https://22jul.newdeaf.co/film/5829-bjetmen-2022-subtitry.html",
  }), false);
  assert.equal(cleanNewdeafTitle("Бэтмен (2022) - русские субтитры"), "Бэтмен (2022)");
});

test("recommendation matching defers an ambiguous remake until year metadata arrives", () => {
  const { pickExactNewdeafResult } = matcherApi();
  const results = [
    {
      title: "Бэтмен (1989) - русские субтитры",
      url: "https://22jul.newdeaf.co/film/100-bjetmen-1989-subtitry.html",
    },
    {
      title: "Бэтмен (2022) - русские субтитры",
      url: "https://22jul.newdeaf.co/film/5829-bjetmen-2022-subtitry.html",
    },
  ];
  assert.equal(pickExactNewdeafResult(results, { title: "Бэтмен", isSeries: false }), null);
  assert.equal(
    pickExactNewdeafResult(results, { title: "Бэтмен", year: "2022", isSeries: false })?.url,
    results[1].url,
  );
});

test("a recommendation upgrades from kp to a verified cached Ortified target", async () => {
  const pageUrl = "https://22jul.newdeaf.co/film/184-bjetmen-protiv-supermena-na-zare-spravedlivosti-2016-subtitry.html";
  const embedUrl = "https://api.ortified.ws/embed/movie/106";
  const title = "Бэтмен против Супермена: На заре справедливости";
  const expires = Date.now() + 60_000;
  const storageSeed = new Map([
    [`alphy.cache.ndsearch.v2:${title.toLowerCase()}`, JSON.stringify({
      v: [{ title: `${title} (2016)`, url: pageUrl, poster: "https://posters/newdeaf.webp" }],
      exp: expires,
    })],
    [`alphy.cache.ndpage:${pageUrl}`, JSON.stringify({
      v: { title, year: "2016", poster: "", description: "", ortified: [embedUrl], opravar: [], allo: [] },
      exp: expires,
    })],
  ]);
  const ctx = makeSandbox({ storageSeed });
  ctx.run();

  const target = await ctx.sandbox.window.alphyBridge._test.resolveRecommendationTarget({
    id: "fy-123",
    title,
    year: "2016",
    poster: "https://posters/kp.jpg",
    isSeries: false,
    target: { kind: "kp", kpId: "123" },
  });

  assert.equal(target.kind, "ort");
  assert.equal(target.embedUrl, embedUrl);
  const cached = JSON.parse(ctx.storage.get("alphy.cache.ndrecommend.v1:kp:123"));
  assert.equal(cached.v.target.kind, "ort");
  assert.equal(cached.v.target.embedUrl, embedUrl);
  assert.ok(ctx.storage.has(`alphy.cache.ortmeta:${embedUrl}`));
});

test("a recommendation click navigates immediately while client sources race", async () => {
  const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const clickStart = source.indexOf("function openRecommendationItem");
  const clickEnd = source.indexOf("async function prepareTarget", clickStart);
  const click = source.slice(clickStart, clickEnd);
  assert.ok(clickStart > 0 && clickEnd > clickStart);
  assert.doesNotMatch(click, /\bawait\b/, "navigation must not wait for a provider lookup");
  assert.match(click, /recommendationContextByKp\.set/);
  assert.match(click, /prepareRecommendation\(item\)\.catch/);
  assert.match(click, /return openCuratedItem/);

  const raceStart = source.indexOf("async function resolveRecommendationPlaybackSource");
  const raceEnd = source.indexOf("async function prepareRecommendation", raceStart);
  const race = source.slice(raceStart, raceEnd);
  assert.match(race, /resolveRecommendationTarget/);
  assert.match(race, /probeCollapsMovie/);
  assert.match(race, /findLiftwByKpId/);
  assert.match(race, /firstAvailable/);
  assert.doesNotMatch(race, /resolveZona/, "hover/pointer warming must not spend shared resolver capacity");
});
