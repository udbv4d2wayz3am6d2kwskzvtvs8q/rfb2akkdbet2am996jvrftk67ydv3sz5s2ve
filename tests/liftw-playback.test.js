import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { makeSandbox, sleep } from "./helpers/app-sandbox.js";

// LiftW ships the same player-venom `makePlayer({...})` embed Zenith does, which
// is the whole reason the integration reuses parseZenithEmbed/normalizeSerialSeasons
// instead of adding a second parser. These tests pin that against the real thing:
// the fixtures are captured api.liftw.ws responses with only the CDN signatures
// replaced by placeholders, so a shape change upstream fails here rather than in
// the player.

const fixture = (name) => readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
// The app runs in a vm, so its objects and arrays carry that realm's prototypes
// and deepEqual would compare identities rather than values.
const plain = (value) => JSON.parse(JSON.stringify(value));
const fixtureJson = async (name) => JSON.parse(await fixture(name));

async function liftwSandbox({ mediaSource } = {}) {
  const ctx = makeSandbox();
  // canPlayLiftwCodec reads window.MediaSource, which a vm has no business
  // providing. Stub it per-test to drive each ladder branch.
  if (mediaSource !== undefined) ctx.sandbox.MediaSource = mediaSource;
  ctx.run();
  await sleep(80);
  return ctx.sandbox.window.alphyBridge._test;
}

const supports = (...types) => ({ isTypeSupported: (t) => types.some((x) => t.startsWith(x)) });
const AV1 = "video/webm; codecs=\"av01";
const VP9 = "video/webm; codecs=\"vp09";
const OPUS = "audio/webm; codecs=\"opus";

test("a real LiftW movie embed yields all three ladders, dub names and subtitles", async () => {
  const helpers = await liftwSandbox();
  const html = await fixture("liftw-embed-movie.html");
  const parsed = helpers.parseZenithEmbed(html);

  assert.deepEqual(plain(Object.keys(parsed.sources)).sort(), ["dash", "dasha", "hls"]);
  assert.match(parsed.sources.hls, /^https:\/\/hye1eaipby4w\.interkh\.com\/.*\/master\.m3u8\?/);
  assert.match(parsed.sources.dash, /^https:\/\/hye1eaipby4w\.interkh\.com\/.*\.mpd\?/);
  assert.match(parsed.sources.dasha, /^https:\/\/hye1eaipby4w\.interkh\.com\/.*\.mpd\?/);
  assert.notEqual(parsed.sources.dash, parsed.sources.dasha, "VP9 and AV1 are distinct manifests");

  assert.deepEqual(plain(parsed.meta.audioNames), [
    "Рус. Дублированный", "HDRezka Studio", "JASKIER", "LeDoyen (укр)", "Eng.Original",
  ]);
  assert.equal(parsed.playlist.seasons.length, 0, "a movie must not look like a serial");

  const tracks = helpers.liftwTextTracks(html);
  assert.equal(tracks.length, 6);
  assert.deepEqual(plain(tracks).map((t) => t.language), ["en", "uk", "uk", "ru", "ru", "en"]);
  assert.ok(tracks.every((t) => /^https:\/\/[a-z0-9-]+\.interkh\.com\/.*\.vtt\?/.test(t.url)));
});

test("a real LiftW series embed carries every episode, sorted, with per-episode audio and subs", async () => {
  const helpers = await liftwSandbox();
  const parsed = helpers.parseZenithEmbed(await fixture("liftw-embed-series.html"));

  // The fixture stores seasons as LiftW emits them — out of order (1, 4, 2).
  assert.deepEqual(plain(parsed.playlist.seasons).map((s) => s.season), [1, 2, 4]);
  assert.deepEqual(plain(parsed.playlist.current), { season: 1, episode: 1 });

  const episode = parsed.playlist.seasons[0].episodes[0];
  assert.deepEqual(plain(Object.keys(episode.sources)).sort(), ["dash", "dasha", "hls"]);
  // Озвучка differs per episode on LiftW — a season can change studios mid-run —
  // so it must ride on the episode, not on the document.
  assert.ok(episode.audioNames.includes("Дмитрий \"Goblin\" Пучков"));
  assert.equal(episode.textTracks.length, 2);
  assert.deepEqual(plain(episode.textTracks).map((t) => t.language), ["en", "ru"]);
  assert.ok(episode.textTracks.every((t) => t.url.startsWith("https://hye1eaipby4w.interkh.com/")));

  // Every episode is fully resolved in this one fetch, which is what makes
  // switching episodes cost zero network.
  for (const season of parsed.playlist.seasons) {
    for (const ep of season.episodes) assert.ok(ep.sources.hls, `s${season.season}e${ep.episode} has no stream`);
  }

  const picked = helpers.chooseSerialSelection(parsed.playlist.seasons, { season: 4, episode: 2 });
  assert.deepEqual(plain({ season: picked.season, episode: picked.episode }), { season: 4, episode: 2 });
});

test("the ladder chooser prefers the cheapest codec the browser can actually decode", async () => {
  const sources = { hls: "h", dash: "v", dasha: "a" };

  const av1 = await liftwSandbox({ mediaSource: supports(AV1, VP9, OPUS) });
  assert.deepEqual(plain(av1.bestLiftwSource(sources)), { url: "a", kind: "dasha" });

  const vp9 = await liftwSandbox({ mediaSource: supports(VP9, OPUS) });
  assert.deepEqual(plain(vp9.bestLiftwSource(sources)), { url: "v", kind: "dash" });

  // Both WebM ladders are Opus-only, so a browser without Opus in MSE gets HLS
  // even though it claims to decode the video codecs.
  const noOpus = await liftwSandbox({ mediaSource: supports(AV1, VP9) });
  assert.deepEqual(plain(noOpus.bestLiftwSource(sources)), { url: "h", kind: "hls" });

  // No MediaSource at all (or a throwing one) must fail safe onto HLS, never crash.
  const bare = await liftwSandbox({ mediaSource: undefined });
  assert.deepEqual(plain(bare.bestLiftwSource(sources)), { url: "h", kind: "hls" });
  const angry = await liftwSandbox({ mediaSource: { isTypeSupported: () => { throw new Error("nope"); } } });
  assert.deepEqual(plain(angry.bestLiftwSource(sources)), { url: "h", kind: "hls" });

  assert.equal(bare.bestLiftwSource({}), null);
  assert.equal(bare.bestLiftwSource(null), null);
  // A title with only a WebM ladder still plays rather than being dropped.
  assert.deepEqual(plain(bare.bestLiftwSource({ dasha: "a" })), { url: "a", kind: "dasha" });
});

test("the embed is retried on a second host, and only the signed /info URL seeds it", async () => {
  const helpers = await liftwSandbox();
  const info = await fixtureJson("liftw-info-movie.json");

  const candidates = helpers.liftwEmbedCandidates(info.iframe_uri);
  // lift3.ws is tried first: embed.liftw.ws is the host that is blocked in
  // Russia, and it stays last as the fallback for addresses lift3.ws refuses.
  assert.ok(candidates.length >= 2, `expected several candidates, saw ${candidates.length}`);
  assert.equal(new URL(candidates[0]).hostname, "lift3.ws");
  // embed.liftw.ws is the blocked host: attempting it from the browser could
  // only ever burn a timeout, so the last resort is our own relay, which tries
  // both hosts server-side instead.
  assert.ok(candidates.every((url) => new URL(url).hostname !== "embed.liftw.ws"),
    `a blocked host must never be fetched directly: ${candidates.join(" ")}`);
  assert.match(new URL(candidates.at(-1)).hostname, /supabase\.co$/);
  assert.equal(new URL(candidates.at(-1)).searchParams.get("mode"), "embed");
  // The signature from /info must survive the host swap.
  assert.equal(new URL(candidates[0]).search, new URL(info.iframe_uri).search);
  const id = new URL(info.iframe_uri).pathname.match(/(\d+)/)[1];
  assert.ok(candidates.slice(0, -1).every((url) => new URL(url).pathname.endsWith(id)));
  // ...and reach the relay as parts, so the relay rebuilds rather than forwards.
  assert.equal(new URL(candidates.at(-1)).searchParams.get("id"), id);
  assert.equal(new URL(candidates.at(-1)).searchParams.get("imp2"),
    new URL(info.iframe_uri).searchParams.get("imp2"));

  // The validator still admits nothing but the exact host and numeric path.
  assert.equal(helpers.liftwEmbedCandidates("http://embed.liftw.ws/embed/movie/51984").length, 0, "http://embed.liftw.ws/embed/movie/51984");
  assert.equal(helpers.liftwEmbedCandidates("https://embed.liftw.ws.evil.example/embed/movie/51984").length, 0, "https://embed.liftw.ws.evil.example/embed/movie/51984");
  assert.equal(helpers.liftwEmbedCandidates("https://embed.liftw.ws/embed/movie/../../etc").length, 0, "https://embed.liftw.ws/embed/movie/../../etc");
  assert.equal(helpers.liftwEmbedCandidates("https://lift3.ws/embed/movie/51984").length, 0, "https://lift3.ws/embed/movie/51984");
  assert.equal(helpers.liftwEmbedCandidates("javascript:alert(1)").length, 0, "javascript:alert(1)");
  assert.equal(helpers.liftwEmbedCandidates("").length, 0, "");
  assert.equal(helpers.liftwEmbedCandidates(null).length, 0, null);
});

test("LiftW /info alone is rich enough to render a watch page", async () => {
  const helpers = await liftwSandbox();

  const movie = helpers.liftwMeta(await fixtureJson("liftw-info-movie.json"));
  assert.equal(movie.title, "Человек-паук: Нет пути домой");
  assert.equal(movie.originalTitle, "Spider-Man: No Way Home");
  assert.equal(movie.year, 2021);
  assert.equal(movie.isSeries, false);
  assert.equal(movie.movieLength, 148, "\"148 мин. / 02:28\" must become minutes");
  assert.equal(movie.ageRating, 12);
  assert.equal(movie.ratingMpaa, "pg-13");
  assert.deepEqual(plain(movie.countries), ["США"]);
  assert.deepEqual(plain(movie.rating), { kp: 8.8, imdb: 9.4 });
  assert.deepEqual(plain(movie.people.directors), [{ name: "Джон Уоттс" }]);
  // kpId comes free, so a LiftW watch page never spends a Kinopoisk key.
  assert.equal(movie.kpId, "1309570");

  const series = helpers.liftwMeta(await fixtureJson("liftw-info-series.json"));
  assert.equal(series.title, "Клан Сопрано");
  assert.equal(series.isSeries, true);
  assert.equal(series.kpId, "79848");
  assert.ok(series.description.startsWith("Повседневная жизнь"));
  assert.deepEqual(plain(series.people.cast).slice(0, 2), [{ name: "Джеймс Гандольфини" }, { name: "Лоррейн Бракко" }]);

  // A junk payload must degrade to an empty shape, not throw on the watch path.
  assert.equal(helpers.liftwMeta(null).title, "");
  assert.equal(helpers.liftwMeta({ info: null }).movieLength, null);
  assert.deepEqual(plain(helpers.liftwMeta({}).rating), { kp: null, imdb: null });
});

test("LiftW routes round-trip through the hash router for movies and episodes", async () => {
  const helpers = await liftwSandbox();

  const movie = helpers.liftwTarget("51984");
  assert.equal(helpers.keyFor(movie), "lift:51984");
  assert.equal(helpers.hashFor(movie), "/l/51984");
  assert.deepEqual(plain(helpers.parsePathRoute("/l/51984")), {
    view: "watch", kind: "lift", raw: "51984", selection: null,
  });

  const episode = helpers.liftwTarget("2625", { season: 2, episode: 5 });
  assert.equal(helpers.hashFor(episode), "/l/2625/s2e5");
  assert.equal(helpers.keyFor(episode), "lift:2625", "history must key on the title, not the episode");
  assert.deepEqual(plain(helpers.parsePathRoute("/l/2625/s2e5")), {
    view: "watch", kind: "lift", raw: "2625", selection: { season: 2, episode: 5 },
  });

  // Ids are numeric upstream; anything else falls back to home rather than
  // opening a watch page that can never resolve.
  assert.deepEqual(plain(helpers.parsePathRoute("/l/not-an-id")), { view: "home" });
  assert.deepEqual(plain(helpers.parsePathRoute("/l/")), { view: "home" });
  // A malformed episode suffix still opens the title, at its default episode.
  assert.equal(plain(helpers.parsePathRoute("/l/51984/junk")).selection, null);
});

test("every dub is offered under its real name on both ladders", async () => {
  const helpers = await liftwSandbox();
  // The five names the movie embed ships, in the order the manifests index them.
  const names = ["Рус. Дублированный", "HDRezka Studio", "JASKIER", "LeDoyen (укр)", "Eng.Original"];
  helpers.setAudioNames(names);

  // DASH puts the positional name straight into lang=.
  const dash = ["rus0", "rus1", "rus2", "ukr3", "eng4"].map((language) => ({ language, label: null }));
  assert.deepEqual(dash.map((t, i) => helpers.audioNameFor(t, i)), names);

  // HLS gives every Russian dub LANGUAGE="ru" and only distinguishes them by
  // NAME, which Shaka reports as `label`. Reading the label is what stops all
  // three from being labelled "Рус. Дублированный".
  const hls = [
    { language: "ru", label: "rus0" }, { language: "ru", label: "rus1" }, { language: "ru", label: "rus2" },
    { language: "uk", label: "ukr3" }, { language: "en", label: "eng4" },
  ];
  assert.deepEqual(hls.map((t, i) => helpers.audioNameFor(t, i)), names);

  // A provider with neither (Zenith's plain manifests) still falls back to the
  // positional name, and then to whatever the manifest called the track.
  assert.equal(helpers.audioNameFor({ language: "ru" }, 1), "HDRezka Studio");
  helpers.setAudioNames([]);
  assert.equal(helpers.audioNameFor({ language: "ru" }, 0), "ru");
  assert.equal(helpers.audioNameFor({}, 0), "unknown");
});

test("episode switches preserve the dub by studio name before positional manifest tags", async () => {
  const helpers = await liftwSandbox();
  const wanted = helpers.audioPreferenceForChoice({
    track: { language: "ru", label: "rus1" },
    name: "LostFilm.TV",
  });
  const nextEpisode = [
    { track: { language: "ru", label: "rus1" }, name: "Кубик в кубе", blocked: false },
    { track: { language: "ru", label: "rus4" }, name: "LostFilm", blocked: false },
    { track: { language: "en", label: "eng5" }, name: "English Original", blocked: false },
  ];

  assert.equal(helpers.chooseAudioPreference(nextEpisode, wanted).track.label, "rus4");

  // If the studio is absent in one episode, staying in the same language is a
  // better fallback than silently jumping to the English original.
  assert.equal(
    helpers.chooseAudioPreference(nextEpisode.filter((choice) => choice.name !== "LostFilm"), wanted).track.label,
    "rus1",
  );
});

test("episode switches treat subtitle variants in the same language as compatible", async () => {
  const helpers = await liftwSandbox();
  const wanted = helpers.cleanSubtitlePreference({
    enabled: true,
    requested: true,
    label: "English SDH",
    language: "en-US",
  });
  const nextEpisode = [
    { id: 1, language: "ru", label: "Русские полные" },
    { id: 2, language: "en", label: "English Full Generated" },
  ];

  assert.equal(helpers.chooseSubtitleTrack(nextEpisode, wanted).id, 2);
  assert.equal(helpers.mediaLanguageFamily("eng7", "English Original"), "en");
  assert.equal(helpers.mediaLanguageFamily("rus2", "LostFilm"), "ru");
});

test("Opravar and Collaps keep a named voice when provider ids change per episode", async () => {
  const helpers = await liftwSandbox();
  const oprPlaylist = [{ season: 1, episodes: [
    { episode: 1, voices: [{ voiceId: 7, videoId: 701, name: "LostFilm" }] },
    { episode: 2, voices: [
      { voiceId: 7, videoId: 702, name: "Другая студия" },
      { voiceId: 12, videoId: 712, name: "LostFilm.TV" },
    ] },
  ] }];
  const opr = helpers.chooseOpravarSelection(oprPlaylist, {
    season: 1, episode: 2, voiceId: 7, voiceName: "LostFilm",
  });
  assert.equal(opr.videoId, 712);

  const collaps = helpers.chooseCollapsSelection({
    isSerial: true,
    seasons: [{ season: 1, episodes: [{ episode: 2, voices: [
      { vkId: "new-a", voiceStudio: "Другая студия" },
      { vkId: "new-b", voiceStudio: "LostFilm.TV" },
    ] }] }],
  }, {
    season: 1, episode: 2, vkId: "old-id", voiceIndex: 0, voiceName: "LostFilm",
  });
  assert.equal(collaps.vkId, "new-b");
});

test("player-venom soundBlock entries never become audio buttons", async () => {
  const helpers = await liftwSandbox();
  const parsed = helpers.parseZenithEmbed(`
    makePlayer({
      soundBlock: "delete, Broken mix",
      source: { audio: { "names": ["Main", "", "delete", "Broken mix"] } }
    });
  `);

  assert.deepEqual(plain(parsed.meta.audioNames), ["Main", "", "delete", "Broken mix"]);
  assert.deepEqual(plain(parsed.meta.blockedAudioNames), ["delete", "Broken mix"]);

  helpers.setAudioNames(parsed.meta.audioNames);
  helpers.setBlockedAudioNames(parsed.meta.blockedAudioNames);
  const choices = helpers.shakaAudioChoices([
    { language: "ru", label: "rus0", active: false, height: 480 },
    { language: "ru", label: "rus0", active: true, height: 1080 },
    { language: "en", label: "eng2", active: false, height: 1080 },
    { language: "en", label: "eng3", active: false, height: 1080 },
  ]);

  assert.deepEqual(plain(choices).map((choice) => choice.name), ["Main"]);
  assert.equal(choices[0].track.active, true, "the active quality must represent its dub button");

  // Cached parses made before soundBlock support have no block list. The
  // upstream sentinel is still hidden rather than leaking back until cache TTL.
  helpers.setBlockedAudioNames([]);
  assert.equal(helpers.isBlockedAudioName(" DELETE "), true);
});

test("clicking a dub selects that dub, not merely its language", async () => {
  const helpers = await liftwSandbox();
  const calls = [];
  const player = {
    selectVariantsByLabel: (label) => calls.push(["label", label]),
    selectAudioLanguage: (language, role) => calls.push(["language", language, role]),
    getConfiguration: () => ({ abr: { enabled: true } }),
    configure: () => {},
    getVariantTracks: () => [],
    selectVariantTrack: () => {},
  };

  // Three tracks share LANGUAGE="ru"; selectAudioLanguage("ru") would always
  // land on the first, so the label API must be used instead.
  helpers.selectShakaAudio(player, { language: "ru", label: "rus2" });
  assert.deepEqual(calls, [["label", "rus2"]]);

  // Without a label there is nothing to disambiguate, so the language API stays.
  calls.length = 0;
  helpers.selectShakaAudio(player, { language: "rus1", label: "", roles: ["main"] });
  assert.deepEqual(calls, [["language", "rus1", "main"]]);

  // An older Shaka without the label API must still switch, not throw.
  calls.length = 0;
  helpers.selectShakaAudio({ ...player, selectVariantsByLabel: undefined }, { language: "ru", label: "rus2" });
  assert.deepEqual(calls, [["language", "ru", undefined]]);

  // The remembered tag prefers the label, so a dub chosen on the HLS fallback is
  // still the dub restored on DASH — the two ladders spell it the same way.
  assert.equal(helpers.audioTag({ language: "ru", label: "rus1" }), "rus1");
  assert.equal(helpers.audioTag({ language: "rus1" }), "rus1");
  assert.equal(helpers.audioTag(null), "");
});

test("the LiftW control plane stays fail-closed, and no stream crosses our servers", async () => {
  const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const embed = source.slice(source.indexOf("async function fetchLiftwEmbed"));
  const block = embed.slice(0, embed.indexOf("\n  }") + 4);
  // The embed still runs inside the null-origin sandbox and must NOT fall back
  // to a direct fetch, which would expose alphy.tv to the host.
  assert.match(block, /preferSandbox:\s*true/);
  assert.match(block, /directFallback:\s*false/);

  // /info and search now go through the relay instead, so LiftW sees a shard
  // rather than the viewer — but the relay must never carry media.
  const relay = source.slice(source.indexOf("function liftwEndpointOrder"));
  assert.match(relay.slice(0, 2400), /LIFTW_ENDPOINTS/);
  assert.match(relay.slice(0, 2400), /liftwCooldown\.set/);
  const fn = await readFile(new URL("../supabase/functions/liftw/index.ts", import.meta.url), "utf8");
  assert.match(fn, /mode === "info"/);
  assert.match(fn, /mode === "search"/);
  // Not a general proxy: nothing but the two known shapes may be reached, and
  // the id/query are validated here rather than forwarded.
  assert.doesNotMatch(fn, /searchParams\.get\("url"\)/);
  assert.match(fn, /\^\\d\{1,12\}\$/);
  assert.doesNotMatch(fn, /interkh|\.m3u8|\.mpd/);
});

test("the LiftW media plane accepts only interkh and is wrapped for opaque Shaka fetches", async () => {
  const helpers = await liftwSandbox();
  const media = "https://hye1eaipby4w.interkh.com/a/master.m3u8?t=1&x=two";
  const wrapped = helpers.liftwOpaqueUri(media);

  assert.equal(helpers.isLiftwMediaUrl(media), true);
  assert.equal(helpers.liftwUriFromOpaque(wrapped), media);
  assert.match(wrapped, /^alphy-liftw:/);
  assert.equal(helpers.isLiftwMediaUrl("https://interkh.com/a.mpd"), false);
  assert.equal(helpers.isLiftwMediaUrl("https://evilinterkh.com/a.mpd"), false);
  assert.equal(helpers.isLiftwMediaUrl("https://hye1eaipby4w.interkh.com.evil.example/a.mpd"), false);
  assert.throws(() => helpers.liftwOpaqueUri("https://example.com/a.mpd"), /blocked media URL/);
  assert.throws(() => helpers.liftwUriFromOpaque("alphy-liftw:https%3A%2F%2Fexample.com%2Fa.mpd"), /blocked/);
});

test("LiftW playback opts into the opaque media scheme for movies and episode switches", async () => {
  const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const playStart = source.indexOf("async function playLiftw");
  const playEnd = source.indexOf("function persistSerialSelection", playStart);
  const block = source.slice(playStart, playEnd);

  assert.ok(playStart >= 0 && playEnd > playStart);
  assert.equal(block.match(/opaqueMedia:\s*"liftw"/g)?.length, 2);
  const probeStart = source.indexOf("async function liftwAv1IsHealthy");
  const probeEnd = source.indexOf("function topDashRepresentation", probeStart);
  assert.doesNotMatch(source.slice(probeStart, probeEnd), /\bfetch\s*\(/,
    "the speculative manifest probe must not leak the top-level Origin");
  assert.match(source, /phase:\s*'progress'/,
    "the opaque broker must keep Shaka's stall timer and ABR estimator informed");

  const brokerStart = source.indexOf("const controllers = new Map();", source.indexOf("function liftwMediaBroker"));
  const brokerEnd = source.indexOf("<\\/script>`", brokerStart);
  assert.ok(brokerStart >= 0 && brokerEnd > brokerStart);
  assert.doesNotThrow(() => new Function(source.slice(brokerStart, brokerEnd)),
    "the JavaScript embedded in the opaque media iframe must compile independently");
});

test("episode switching distinguishes live target identity from canonical history identity", async () => {
  const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const start = source.indexOf("async function switchLiftwSelection");
  const end = source.indexOf("function persistSerialSelection", start);
  const block = source.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(block, /state\.currentTarget !== target/,
    "the switch must only stop when navigation replaced the active target object");
  assert.doesNotMatch(block, /keyFor\(state\.currentTarget\) !== context\.histKey/,
    "lift:<id> can never equal the canonical kp:<id> history bucket");
  assert.match(block, /startTracking\(context\.histKey, target\)/,
    "the canonical key is still required for progress persistence");
});

test("the sandbox allowlist admits the host the app actually fetches", async () => {
  const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
  // The allowlist exists twice — once parent-side, once inside the srcdoc — and
  // a host missing from either is rejected before it leaves the browser. lift3
  // was missing from both, so every attempt fell through to the blocked host
  // and timed out: the source looked dead while the fix was already deployed.
  assert.equal(source.match(/host === ['"]lift3\.ws['"]/g)?.length, 2,
    "lift3.ws must be in both the parent guard and the srcdoc guard");
  // api.liftw.ws is no longer fetched from the browser at all.
  assert.doesNotMatch(source, /host === ['"]api\.liftw\.ws['"]/);
});
