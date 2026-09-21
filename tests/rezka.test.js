import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import worker from "../worker/src/index.js";
import {
  RezkaClient,
  parseStreams,
  parseSubtitles,
  parseTranslators,
  chooseSearchResult,
  parseSearchResults,
  decodeStreamString,
} from "../worker/src/rezka.js";

const env = { ALLOWED_ORIGIN: "https://alphy.tv" };

// --- Stream gating: only anonymous full-film MP4s are ever playable -----------

test("parseStreams exposes anonymous MP4s and never registered/premium placeholders", () => {
  const value = [
    "[360p]https://cdn.test/360.mp4",
    "[480p]https://cdn.test/480.mp4",
    "[720p]https://cdn.test/720.mp4",
    '[<span class="pjs-registered-quality">1080p</span>]null',
    '[<span class="pjs-prem-quality">4K</span>]https://cdn.test/preview.mp4',
  ].join(",");
  const streams = parseStreams(value);
  const playable = streams.filter((s) => s.available).map((s) => s.label);
  assert.deepEqual(playable, ["360p", "480p", "720p"]);
  assert.equal(streams.find((s) => s.label === "1080p").url, null);
  const k4 = streams.find((s) => s.label === "4K");
  assert.equal(k4.available, false, "premium sample is never playable");
  assert.equal(k4.url, null, "premium placeholder URL is withheld");
});

test("decodeStreamString base64-decodes the #h obfuscated form (UTF-8 safe)", () => {
  const plain = "[720p]https://cdn.test/фильм.mp4";
  const b64 = Buffer.from(plain, "utf8").toString("base64");
  assert.equal(decodeStreamString(`#h${b64}`), plain);
  assert.equal(decodeStreamString(plain), plain, "unobfuscated strings pass through");
});

test("RezkaClient does not method-bind a Web IDL fetch implementation", async () => {
  function strictFetch() {
    assert.equal(this, undefined);
    return Promise.resolve(new Response("ok"));
  }
  const client = new RezkaClient({ fetchImpl: strictFetch });
  const response = await client.fetchWithTimeout("https://example.test/");
  assert.equal(await response.text(), "ok");
});

test("RezkaClient forwards only a valid viewer IP for CDN signing", () => {
  const client = new RezkaClient({ clientIp: "203.0.113.7" });
  assert.equal(client.appHeaders()["CF-Connecting-IP"], "203.0.113.7");

  const mapped = new RezkaClient({ clientIp: "::ffff:203.0.113.7" });
  assert.equal(mapped.appHeaders()["CF-Connecting-IP"], "203.0.113.7");

  const invalid = new RezkaClient({ clientIp: "203.0.113.7\r\nx-bad: yes" });
  assert.equal(invalid.appHeaders()["CF-Connecting-IP"], undefined);
});

// --- Subtitles from the get_movie response ------------------------------------

test("parseSubtitles reads the PlayerJS subtitle string + language map", () => {
  const subs = parseSubtitles(
    "[Русский]https://s.test/ru.vtt,[English]https://s.test/en.vtt",
    { "откл.": "", "Русский": "ru", "English": "en" },
    "ru",
  );
  assert.equal(subs.length, 2);
  assert.deepEqual(subs[0], { lang: "ru", label: "Русский", url: "https://s.test/ru.vtt", default: true });
  assert.equal(subs[1].lang, "en");
  assert.equal(subs[1].default, false);
});

test("parseSubtitles tolerates the no-subtitles case", () => {
  assert.deepEqual(parseSubtitles(false), []);
  assert.deepEqual(parseSubtitles(""), []);
  assert.deepEqual(parseSubtitles(undefined), []);
});

// --- Audio tracks (dubs) from the film page -----------------------------------

test("parseTranslators pulls dubs from the translators list, with flags", () => {
  const html = `
    <ul id="translators-list">
      <li data-translator_id="56" data-director="1">Дубляж</li>
      <li data-translator_id="238" data-camrip="1">Многоголосый</li>
    </ul>`;
  const list = parseTranslators(html);
  assert.equal(list.length, 2);
  assert.equal(list[0].id, 56);
  assert.equal(list[0].name, "Дубляж");
  assert.equal(list[0].director, 1);
  assert.equal(list[1].id, 238);
  assert.equal(list[1].camrip, 1);
});

test("parseTranslators returns [] when the page has no list (single-dub / WAF 403)", () => {
  assert.deepEqual(parseTranslators("<html>403</html>"), []);
  assert.deepEqual(parseTranslators(""), []);
});

// --- Search result ranking ----------------------------------------------------

test("chooseSearchResult prefers exact title + matching year", () => {
  const html =
    '<div class="b-content__inline_item" data-id="657">' +
    '<div class="b-content__inline_item-link"><a href="https://hdrzk.org/films/action/657-x.html">' +
    "Тихоокеанский рубеж</a><div>2013, США, Боевики</div></div></div>" +
    '<div class="b-content__inline_item" data-id="27289">' +
    '<div class="b-content__inline_item-link"><a href="https://hdrzk.org/films/action/27289-x.html">' +
    "Тихоокеанский рубеж 2</a><div>2018, США, Боевики</div></div></div>";
  const results = parseSearchResults(html);
  assert.equal(chooseSearchResult(results, "Тихоокеанский рубеж", 2013).rezkaId, 657);
});

test("chooseSearchResult never upgrades a partial title or the wrong remake", () => {
  const results = [
    { rezkaId: 1, title: "Бэтмен", year: 1989 },
    { rezkaId: 2, title: "Бэтмен", year: 2022 },
    { rezkaId: 3, title: "Лего Фильм: Бэтмен", year: 2017 },
  ];
  assert.equal(chooseSearchResult(results, "Бэтмен", 2022)?.rezkaId, 2);
  assert.equal(chooseSearchResult(results, "Бэтмен", 2010), null);
  assert.equal(chooseSearchResult(results, "Лего Бэтмен", 2017), null);
  assert.equal(chooseSearchResult(results, "Бэтмен", null), null);
});

// --- Endpoint validation (hermetic: rejects before any upstream call) ----------

test("/resolve-rezka rejects a request with no id/title", async () => {
  const res = await worker.fetch(new Request("http://local/resolve-rezka"), env);
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.error, "missing_id_or_title");
});

// The resolver used to accept a bare kpId and ask Collaps what it was called.
// That single call was the only time this backend spoke to a source itself, so it
// handed Collaps a datacenter IP with a fixed User-Agent once per Rezka resolve —
// a cleaner correlation handle than anything the sandboxed browser path leaks.
// Rejecting kp-only is what keeps it deleted: a future caller cannot quietly
// reintroduce the lookup by passing kp and hoping for the best.
test("/resolve-rezka refuses a kp-only request instead of looking the title up", async () => {
  const res = await worker.fetch(new Request("http://local/resolve-rezka?kp=258687"), env);
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.error, "missing_id_or_title");
});

test("the Rezka resolver never contacts Collaps", async () => {
  const source = await readFile(new URL("../worker/src/rezka.js", import.meta.url), "utf8");
  assert.ok(!/cdnvideohub/i.test(source), "rezka.js must not reference the Collaps host");
  assert.ok(!/kinoPoiskMetadata/.test(source), "the kpId->title lookup must stay deleted");
});

test("/resolve-rezka rejects a non-numeric kp", async () => {
  const res = await worker.fetch(new Request("http://local/resolve-rezka?kp=abc"), env);
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.error, "invalid_kp");
});

test("/resolve-rezka rejects a non-numeric translator", async () => {
  const res = await worker.fetch(new Request("http://local/resolve-rezka?id=657&translator=xx"), env);
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.error, "invalid_translator");
});

test("/resolve-rezka rejects Cloudflare even when the caller spoofs the Deno handoff header", async () => {
  const request = new Request("http://local/resolve-rezka?id=657", {
    headers: { "x-alphy-client-ip": "203.0.113.7" },
  });
  Object.defineProperty(request, "cf", { value: { colo: "RIX" } });
  const response = await worker.fetch(request, env);
  const body = await response.json();
  assert.equal(response.status, 501);
  assert.equal(body.error, "rezka_requires_deno_relay");
});

test("/resolve-rezka fails closed when Deno cannot determine the viewer IP", async () => {
  const response = await worker.fetch(new Request("http://local/resolve-rezka?id=657"), env);
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.error, "rezka_client_ip_unavailable");
});

test("/resolve-rezka signs for the Deno-supplied viewer IP and exposes lazy dub candidates", async () => {
  const originalFetch = globalThis.fetch;
  const forwarded = [];
  globalThis.fetch = async (input, init = {}) => {
    forwarded.push(new Headers(init.headers).get("cf-connecting-ip"));
    const url = new URL(String(input));
    if (url.pathname === "/") {
      return new Response("ok", { headers: { "set-cookie": "PHPSESSID=test; Path=/" } });
    }
    return new Response(JSON.stringify({
      success: true,
      url: "[360p]https://stream.test/360.mp4,[720p]https://stream.test/720.mp4",
      subtitle: "[Русский]https://subs.test/ru.vtt",
      subtitle_lns: { "Русский": "ru" },
      subtitle_def: "ru",
    }), { headers: { "content-type": "application/json" } });
  };
  try {
    const response = await worker.fetch(new Request("http://local/resolve-rezka?id=657", {
      headers: { "x-alphy-client-ip": "203.0.113.7" },
    }), env);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(forwarded, ["203.0.113.7", "203.0.113.7"]);
    assert.equal(body.best.label, "720p");
    assert.equal(body.translatorCandidates[0].id, body.translatorId);
    assert.equal(body.translatorCandidates.length >= 3, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
