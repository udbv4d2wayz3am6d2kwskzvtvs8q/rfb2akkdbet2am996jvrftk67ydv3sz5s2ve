import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Ortified is LiftW under another hostname, so its embed is the same
// player-venom object we already parse and it can play natively. The point of
// the migration is threefold: resume works, the iframe <video> goes away, and
// the media plane stops carrying our origin.

const source = () => readFile(new URL("../app.js", import.meta.url), "utf8");
const between = (text, from, to) => text.slice(text.indexOf(from), text.indexOf(to));

test("the media plane cannot leak our origin, on the first episode or a later one", async () => {
  const app = await source();
  const play = between(app, "async function playOrtifiedNative", "async function switchOrtSelection");
  const swap = between(app, "async function switchOrtSelection", "// Playback — Ortified cleanroom iframe");

  // Both paths route media through the opaque broker.
  assert.match(play, /opaqueMedia: "liftw"/);
  assert.match(swap, /opaqueMedia: "liftw"/, "an episode switch must not fall back to page fetches");

  // The broker only rewrites hosts it recognises. Anything else would be
  // fetched by the page itself and would carry alphy.tv to the CDN, silently —
  // worse than the iframe. Both entry points refuse instead.
  assert.match(play, /if \(!isLiftwMediaUrl\(media\.url\)\)/);
  assert.match(swap, /!media \|\| !isLiftwMediaUrl\(media\.url\)/);

  // Warming has to happen inside the broker document; a top-level preconnect
  // opens the connection as alphy.tv.
  assert.match(play, /warmLiftwConnections\(\)/);
});

test("nothing about Ortified goes through a server", async () => {
  const app = await source();
  const block = between(app, "async function resolveOrtifiedParsed", "async function switchOrtSelection");
  // api.ortified.ws is reachable and sends CORS, unlike api.liftw.ws — so a
  // relay here would add exposure rather than remove it. The Zenith resolver
  // falls back to a worker; this one deliberately does not.
  assert.match(block, /preferSandbox: true/);
  assert.match(block, /directFallback: false/);
  assert.doesNotMatch(block, /liftwRelay|resolverJson|deno\.net|supabase/i);
  assert.doesNotMatch(block, /forceWorker/);
});

test("a title that cannot play natively falls back to the iframe, and 422 stays actionable", async () => {
  const app = await source();
  const block = between(app, "async function playOrt(", "// Playback — Ortified, native");
  // The embedded player is still a working way to watch, so an unparseable
  // title degrades rather than fails.
  assert.match(block, /playOrtifiedNative\(/);
  assert.match(block, /log\("ort-native-fallback"/);
  assert.match(block, /await playOrtifiedCleanroom\(embedUrl, target, token\)/);
  // A non-Russian address gets 422; retrying the iframe would fail identically,
  // so the actionable message wins over the fallback.
  const guard = block.indexOf("422");
  const fallback = block.indexOf("ort-native-fallback");
  assert.ok(guard > 0 && guard < fallback, "the 422 hint must come before the fallback");
});

test("saved ort: items need no migration, and resume finally works", async () => {
  const app = await source();
  const play = between(app, "async function playOrtifiedNative", "async function switchOrtSelection");
  // The target already stores embedUrl, which carries the id the native path
  // needs — so every curated ort: item plays through the new player as-is.
  assert.match(play, /opts\.histKey \|\| keyFor\(target\)/);
  // The iframe could never be told a position; this is the whole user-visible win.
  assert.match(play, /resume: opts\.resume \?\? resumePosition\(histKey\)/);
  assert.match(play, /startTracking\(histKey, target\)/);
});

test("dubs and subtitles survive, including on movies", async () => {
  const app = await source();
  const block = between(app, "async function resolveOrtifiedParsed", "async function playOrtifiedNative");
  // parseZenithEmbed returns audioNames but no subtitles; a movie's live in the
  // same `cc:` array LiftW reads, and without this the native path would play
  // silently without them.
  assert.match(block, /value\.textTracks = liftwTextTracks\(html\)/);
  const play = between(app, "async function playOrtifiedNative", "async function switchOrtSelection");
  assert.match(play, /parsed\.meta\.audioNames/);
  assert.match(play, /episode\?\.textTracks\?\.length \? episode\.textTracks : parsed\.textTracks/);
});

test("a series shows real dub names, not the manifest's ru0..ruN", async () => {
  const app = await source();
  const play = between(app, "async function playOrtifiedNative", "async function switchOrtSelection");
  const swap = between(app, "async function switchOrtSelection", "// Playback — Ortified cleanroom iframe");
  // Ortified is LiftW: dub names ride on the EPISODE, because a season can
  // change studios mid-run. Reading only the document level left a series
  // labelled ru0..ru7 by the manifest instead of LostFilm / Кубик в кубе /
  // Eng.Original — exactly what Zenith's document-level read would give.
  assert.match(play, /episode\?\.audioNames\?\.length \? episode\.audioNames : parsed\.meta\.audioNames/);
  // And they have to be refreshed on an episode switch, or episode 2 keeps the
  // names of episode 1.
  assert.match(swap, /state\.audioNames = episode\.audioNames\?\.length/);
});

test("an ort series gets its own switcher, not Zenith's", async () => {
  const app = await source();
  // Zenith's switch calls playShaka without opaqueMedia, so reusing it would
  // have dropped the null origin the moment a viewer changed episode.
  assert.match(app, /provider: "ort"/);
  assert.match(app, /state\.serial\?\.provider === "ort"\) renderSerialControls\(state\.serial, switchOrtSelection\)/);
  const zenithSwap = between(app, "async function switchZenithSelection", "async function playLiftw");
  assert.doesNotMatch(zenithSwap, /opaqueMedia/, "Zenith must stay untouched by this change");
});
