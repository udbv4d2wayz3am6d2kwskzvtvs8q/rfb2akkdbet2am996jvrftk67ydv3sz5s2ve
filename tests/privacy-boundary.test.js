import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { makeSandbox, sleep } from "./helpers/app-sandbox.js";

async function privacyHelpers() {
  const ctx = makeSandbox();
  ctx.run();
  await sleep(80);
  return ctx.sandbox.window.alphyBridge._test;
}

test("opaque fetch allowlist accepts only the intended HTTPS provider hosts", async () => {
  const helpers = await privacyHelpers();
  assert.equal(helpers.isOpaqueFetchUrl("https://plapi.cdnvideohub.com/api/v1/player/sv/video/1"), true);
  // api.liftw.ws is blocked in Russia and has no CORS header, so search and
  // /info moved to the relay and are no longer fetched from the browser at all.
  assert.equal(helpers.isOpaqueFetchUrl("https://api.liftw.ws/search?q=test"), false);
  assert.equal(helpers.isOpaqueFetchUrl("https://api.liftw.ws/info/1"), false);
  // The embed still is: lift3.ws serves it to Russian viewers, and the old host
  // stays admitted for viewers lift3.ws turns away. A host missing from this
  // list is rejected before it leaves the browser, which is exactly how lift3
  // silently never got tried and every title fell through to a timeout.
  assert.equal(helpers.isOpaqueFetchUrl("https://lift3.ws/embed/movie/51984?imp2=x"), true);
  assert.equal(helpers.isOpaqueFetchUrl("https://embed.liftw.ws/embed/movie/51984?imp2=x"), true);
  assert.equal(helpers.isOpaqueFetchUrl("https://lift3.ws/embed/movie/not-an-id"), false);
  assert.equal(helpers.isOpaqueFetchUrl("https://lift3.ws/msx/"), false);
  assert.equal(helpers.isOpaqueFetchUrl("https://lift3.ws.evil.example/embed/movie/1"), false);
  assert.equal(helpers.isOpaqueFetchUrl("https://embed.liftw.ws.evil.example/embed/movie/1"), false);
  assert.equal(helpers.isOpaqueFetchUrl("https://api.ortified.ws/embed/movie/1"), true);
  assert.equal(helpers.isOpaqueFetchUrl("https://api.zenithjs.ws/embed/movie/1"), true);
  assert.equal(helpers.isOpaqueFetchUrl("https://22jul.newdeaf.co/search/test"), true);
  assert.equal(helpers.isOpaqueFetchUrl("http://api.ortified.ws/embed/movie/1"), false);
  assert.equal(helpers.isOpaqueFetchUrl("https://api.ortified.ws.evil.example/embed/movie/1"), false);
  assert.equal(helpers.isOpaqueFetchUrl("https://api.liftw.ws.evil.example/search?q=test"), false);
});

test("Collaps broker is limited to its control-plane path", async () => {
  const helpers = await privacyHelpers();
  assert.equal(helpers.isCollapsControlUrl("https://plapi.cdnvideohub.com/api/v1/player/sv/playlist?id=301"), true);
  assert.equal(helpers.isCollapsControlUrl("https://plapi.cdnvideohub.com/api/v1/player/sv/video/1"), true);
  assert.equal(helpers.isCollapsControlUrl("https://plapi.cdnvideohub.com/other"), false);
  assert.equal(helpers.isCollapsControlUrl("https://plapi.cdnvideohub.com.evil.example/api/v1/player/sv/video/1"), false);
});

test("Collaps type 7 is presented before type 6 as the real 4K rendition", async () => {
  const helpers = await privacyHelpers();
  const sources = helpers.normalizeCollapsSources({
    mpeg2kUrl: "https://media.example/type-7",
    mpeg4kUrl: "https://media.example/type-6",
    mpegFullHdUrl: "https://media.example/type-5",
  });
  assert.deepEqual(Array.from(sources, ({ key, label, height }) => [key, label, height]), [
    ["mpeg2kUrl", "4K", 2160],
    ["mpeg4kUrl", "2K", 1440],
    ["mpegFullHdUrl", "1080p", 1080],
  ]);
});

test("Ortified cleanroom keeps the fullscreen-compatible document shape", async () => {
  const helpers = await privacyHelpers();
  const result = helpers.sanitizeOrtifiedHtml(
    "<!doctype html><html><head></head><body><script>makePlayer({})</script></body></html>",
    "https://api.ortified.ws/embed/movie/1",
    "test",
  );
  assert.equal(result.stats.ok, true);
  assert.doesNotMatch(result.html, /<meta name="referrer" content="no-referrer">/i);
  assert.match(result.html, /<base href="https:\/\/api\.ortified\.ws\/">/i);
});

test("Ortified playback keeps its compatible unsandboxed iframe and fetch fallback", async () => {
  const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const start = source.indexOf("async function playOrtifiedCleanroom");
  const end = source.indexOf("// Playback — Zenith", start);
  const block = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(block, /iframe\.allowFullscreen = true/);
  assert.doesNotMatch(block, /iframe\.sandbox\s*=/);
  assert.doesNotMatch(block, /directFallback:\s*false/);
});

// The viewer's browser reaches Collaps through an opaque-origin sandbox, so the
// source sees `Origin: null` and no Referer — measured on the wire, not assumed.
// That whole arrangement was undone by one line on the server: the Rezka resolver
// turned a bare kpId into a title by asking Collaps from Deno, handing it a
// datacenter IP with a fixed User-Agent once per resolve. The browser leaks an IP
// per viewer; the backend leaked one identity for all of them, which is worse.
// This asserts across the whole backend, not just the file it was found in.
test("no backend module talks to Collaps — that path belongs to the viewer's browser", async () => {
  for (const file of ["index.js", "rezka.js", "zona-runtime-and-loader.js"]) {
    const source = await readFile(new URL(`../worker/src/${file}`, import.meta.url), "utf8");
    const code = source.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    assert.ok(
      !/cdnvideohub/i.test(code),
      `worker/src/${file} must not reach Collaps from the server`,
    );
  }
});

// Subtitles on the HDRezka fallback used to be a plain cross-origin fetch, which
// sends `Origin: https://alphy.tv` however the referrer policy is set — Origin is
// not governed by it. Turning subtitles on therefore announced the site to
// Voidboost. Both allowlists have to agree, and the child's copy lives inside a
// template literal where one missing backslash silently changes the regex, so the
// child predicate is extracted and executed rather than pattern-matched.
function childAllowlist(source) {
  // Anchored inside sandboxFetchText: playOrtifiedCleanroom builds a srcdoc too,
  // and that one interpolates, so a bare search for the first `iframe.srcdoc`
  // evaluates the wrong template.
  const fn = source.indexOf("function sandboxFetchText");
  const start = source.indexOf("iframe.srcdoc = `", fn) + "iframe.srcdoc = ".length;
  const end = source.indexOf("`;", start + 1) + 1;
  const html = new Function(`return ${source.slice(start, end)}`)();
  const from = html.indexOf("const allowed =") + "const allowed =".length;
  const expression = html.slice(from, html.indexOf(");", from) + 1);
  return new Function("host", "target", `return ${expression}`);
}

test("the subtitle CDN is reachable through the sandbox, and both allowlists agree", async () => {
  const helpers = await privacyHelpers();
  const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const childAllows = childAllowlist(source);
  const target = { protocol: "https:", pathname: "/1/2/3.vtt" };

  for (const host of ["static.voidboost.com", "static.voidboost.one", "static.voidboost.cc"]) {
    const url = `https://${host}/x/y.vtt`;
    assert.equal(helpers.isOpaqueFetchUrl(url), true, `parent must allow ${host}`);
    assert.equal(childAllows(host, target), true, `child must allow ${host}`);
  }
  // Only the one subdomain, and only over https — not the registrable domain,
  // not a lookalike, not the stream host (native <video> needs no CORS there).
  for (const host of [
    "voidboost.com",
    "stream.voidboost.one",
    "static.voidboost.com.evil.example",
    "evil-static.voidboost.com",
  ]) {
    const url = `https://${host}/x/y.vtt`;
    assert.equal(helpers.isOpaqueFetchUrl(url), false, `parent must reject ${host}`);
    assert.equal(childAllows(host, target), false, `child must reject ${host}`);
  }
  assert.equal(helpers.isOpaqueFetchUrl("http://static.voidboost.com/x.vtt"), false);
  assert.equal(childAllows("static.voidboost.com", { protocol: "http:", pathname: "/x.vtt" }), false);
});

test("HDRezka subtitles never fall back to a direct fetch", async () => {
  const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const start = source.indexOf("async function attachRezkaSubtitles");
  const end = source.indexOf("function renderRezkaControls", start);
  const block = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(block, /sandboxFetchText\(sub\.url/);
  assert.doesNotMatch(block, /\bfetch\(sub\.url/);
});
