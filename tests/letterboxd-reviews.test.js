import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { makeSandbox, sleep } from "./helpers/app-sandbox.js";

// Popular reviews are lifted out of the same film page the rating is scraped
// from, so they cost nothing extra upstream. What these pin is the parsing —
// which is markup-shaped and was wrong in a way no rating test could catch — and
// the one client behaviour that keeps a lagging shard from hiding the block.

// The parser is a plain function inside a Deno module; lift it out rather than
// booting an edge runtime for it.
async function loadParser() {
  const source = await readFile(new URL("../supabase/functions/letterboxd/index.ts", import.meta.url), "utf8");
  const from = source.indexOf("function clip(");
  const to = source.indexOf("const fresh =");
  assert.ok(from > 0 && to > from, "could not find the parser block");
  return new Function(`const REVIEW_LIMIT = 6, REVIEW_MAX_CHARS = 420; ${source.slice(from, to)}; return parseReviews;`)();
}

// The shape Letterboxd actually serves: a spoiler review carries a warning
// paragraph *beside* the body, and the body itself is the js-review-body div.
const review = ({ name = "user", stars = "★★★★", text = "fine", spoiler = false } = {}) => `
  <article class="production-viewing -viewing js-production-viewing" data-person="${name}">
    <div class="attribution-block"><strong class="displayname">${name}</strong></div>
    <span class="inline-symbol inline-rating"><svg aria-label="${stars}"><title>${stars}</title></svg></span>
    <div class="js-review ">
      ${spoiler ? '<p class="body-text -prose js-spoiler-container" data-w="1">This review may contain spoilers.</p>' : ""}
      <div class="body-text -prose -reset js-review-body js-collapsible-text"><p>${text}</p></div>
    </div>
  </article>`;

const page = (...articles) => `<html><body><h2>Popular reviews</h2><div class="viewing-list">${articles.join("")}</div></body></html>`;

test("a spoiler is recognised by the warning beside the body, not a class on it", async () => {
  const parseReviews = await loadParser();
  const parsed = parseReviews(page(
    review({ name: "clean", text: "no spoilers here" }),
    review({ name: "loud", text: "the sled is a sledge", spoiler: true }),
  ));

  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].s, undefined);
  assert.equal(parsed[1].s, true, "js-spoiler-container sits on a sibling <p>, so the whole article must be searched");
  // And the warning paragraph must never be served as the review itself: it is
  // also class="body-text", which is what an earlier anchor matched.
  assert.equal(parsed[1].t, "the sled is a sledge");
  assert.ok(!parsed[1].t.includes("may contain spoilers"));
});

test("half stars survive, and an unrated review is not read as zero", async () => {
  const parseReviews = await loadParser();
  const parsed = parseReviews(page(
    review({ name: "a", stars: "★★★½" }),
    review({ name: "b", stars: "★★★★★" }),
    // Letterboxd omits the element entirely when someone logged no rating.
    `<article class="production-viewing"><strong class="displayname">c</strong>
       <div class="body-text -prose js-review-body">just watched it</div></article>`,
  ));
  assert.deepEqual(parsed.map((item) => item.r), [3.5, 5, null]);
});

test("entities are decoded and the Translate affordance is not served as prose", async () => {
  const parseReviews = await loadParser();
  const [item] = parseReviews(page(review({
    text: "he doesn&#039;t care &amp; that&#039;s the point</p> Translate Translated from English by Google",
  })));
  assert.equal(item.t, "he doesn't care & that's the point");
});

test("a display name cannot reorder the page around it", async () => {
  const parseReviews = await loadParser();
  // A right-to-left override in a username silently reverses everything rendered
  // after it. These have no legitimate use in a name shown inline.
  const [item] = parseReviews(page(review({ name: "‮gnimalf‬ evil" })));
  assert.ok(!/[‪-‮⁦-⁩]/.test(item.a), `bidi survived: ${JSON.stringify(item.a)}`);
  assert.match(item.a, /flaming|evil/i);
});

test("a long review is cut at a sentence and flagged, never mid-word", async () => {
  const parseReviews = await loadParser();
  const long = `${"A serious point about the film. ".repeat(20)}tail`;
  const [item] = parseReviews(page(review({ text: long })));
  assert.ok(item.t.length <= 420, `${item.t.length} chars`);
  assert.equal(item.c, true, "the reader must be told there is more");
  assert.ok(!item.t.endsWith("seri") && !/\s\w{1,3}$/.test(item.t), `cut mid-word: ${JSON.stringify(item.t.slice(-30))}`);
  assert.ok(item.t.endsWith("."), `expected a sentence boundary: ${JSON.stringify(item.t.slice(-30))}`);
});

test("only a handful are kept, and an empty body is skipped entirely", async () => {
  const parseReviews = await loadParser();
  const parsed = parseReviews(page(
    ...Array.from({ length: 12 }, (_, i) => review({ name: `u${i}` })),
  ));
  assert.equal(parsed.length, 6);

  const blank = parseReviews(page(review({ text: "" }), review({ text: "real" })));
  assert.equal(blank.length, 1);
  assert.equal(blank[0].t, "real");
});

test("a page with no reviews section is empty rather than an error", async () => {
  const parseReviews = await loadParser();
  assert.deepEqual(parseReviews("<html><body>nothing here</body></html>"), []);
  assert.deepEqual(parseReviews(""), []);
});

// ---------------------------------------------------------------------------

const ok = (body) => ({ ok: true, status: 200, headers: { get: () => "" }, json: async () => body });

async function boot(handler) {
  const ctx = makeSandbox({ storageSeed: new Map() });
  ctx.run();
  await sleep(80);
  const calls = [];
  ctx.sandbox.fetch = async (url, opts) => {
    calls.push(String(url));
    return handler(String(url), opts, calls.length);
  };
  return { helpers: ctx.sandbox.window.alphyBridge._test, calls, storage: ctx.storage };
}

test("a shard that does not know about reviews is passed over, not believed", async () => {
  // One project can lag behind a deploy. It answers the rating
  // perfectly well and simply omits the key. Reading that as "this film has no
  // reviews" would blank the block for its share of the catalogue.
  const { helpers, calls } = await boot((_url, _opts, number) => {
    if (number === 1) return ok({ found: true, r: 4.27, n: 100, slug: "fight-club" });
    return ok({ found: true, r: 4.27, slug: "fight-club", reviews: [{ a: "sam", r: 4, t: "great" }] });
  });
  const lagging = helpers.letterboxdEndpointOrder("tt0137523")[0];

  const list = await helpers.letterboxdReviews("tt0137523");
  assert.equal(list?.length, 1);
  assert.equal(list[0].t, "great");
  assert.equal(calls.length, 2, "it should have moved on to the next shard");
  // The score it did answer is kept: the watch page asks once for both.
  const before = calls.length;
  assert.equal((await helpers.letterboxdRating("tt0137523"))?.r, 4.27);
  assert.equal(calls.length, before, "the score came with the first answer");
  // Being a version behind is not a fault: that project must stay in the ring
  // for ratings. Had it been put on cooldown, a film that starts there would
  // skip it and land on the next shard instead.
  const sibling = Array.from({ length: 400 }, (_, i) => `tt${1000000 + i}`)
    .find((id) => helpers.letterboxdEndpointOrder(id)[0] === lagging);
  await helpers.letterboxdRating(sibling);
  assert.equal(calls[before].split("?")[0], lagging, "the lagging shard was wrongly cooled off");
});

test("a film that genuinely has none is remembered, not re-asked", async () => {
  let asked = 0;
  const { helpers } = await boot(() => {
    asked += 1;
    return ok({ found: true, r: 4.1, slug: "x", reviews: [] });
  });
  assert.equal(await helpers.letterboxdReviews("tt0111161"), null);
  assert.equal(await helpers.letterboxdReviews("tt0111161"), null);
  assert.equal(asked, 1, "an empty answer is still an answer");
});

test("what a shard returns is bounded and stripped before it reaches the page", async () => {
  const { helpers } = await boot(() => ok({
    found: true,
    r: 4,
    slug: "x",
    reviews: [
      { a: `bad‮name${"x".repeat(80)}`, r: 99, t: `${"long ".repeat(400)}`, s: 1, c: 1 },
      ...Array.from({ length: 20 }, () => ({ a: "spam", r: 3, t: "filler" })),
    ],
  }));
  const list = await helpers.letterboxdReviews("tt0111161");
  assert.ok(list.length <= 6, `${list.length} reviews got through`);
  assert.ok(list[0].a.length <= 40);
  assert.ok(list[0].t.length <= 600);
  assert.equal(list[0].r, 0, "a rating outside 0-5 is dropped rather than shown");
  assert.equal(list[0].s, true);
  assert.ok(!/[‪-‮]/.test(list[0].a), "bidi must not survive the client either");
});

test("only an IMDb id is ever put on the wire", async () => {
  const { helpers, calls } = await boot(() => ok({ found: true, r: 4, reviews: [] }));
  for (const bad of ["", null, "tt", "../../x", "tt1;rm -rf", "javascript:alert(1)"]) {
    assert.equal(await helpers.letterboxdReviews(bad), null, `${JSON.stringify(bad)} was accepted`);
  }
  assert.deepEqual(calls, []);
});

test("the request is opt-in, so a grid never carries review payloads", async () => {
  const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const batch = source.slice(source.indexOf("async function letterboxdBatch"), source.indexOf("async function letterboxdBatch") + 1600);
  assert.doesNotMatch(batch, /reviews/, "the grid path must never ask for reviews");

  const fn = await readFile(new URL("../supabase/functions/letterboxd/index.ts", import.meta.url), "utf8");
  // The map shape a grid reads has no reviews branch at all.
  assert.match(fn, /withReviews = !batch && url\.searchParams\.get\("reviews"\) === "1"/);
});

test("the public batch path is cache-only and cannot bypass freshness", async () => {
  const source = await readFile(new URL("../supabase/functions/letterboxd/index.ts", import.meta.url), "utf8");
  assert.match(source, /const missing = batch \? \[\] : ids\.filter/);
  assert.doesNotMatch(source, /searchParams\.get\("refresh"\)/);
  assert.doesNotMatch(source, /BATCH_FETCH_LIMIT/);
});

test("watch reviews use a compact numeric strip and link the heading", async () => {
  const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const start = source.indexOf("function renderReview");
  const end = source.indexOf("// =====================================================================\n  // Playback — Ortified", start);
  const block = source.slice(start, end);
  assert.match(block, /review-score/);
  assert.match(block, /\/5`/);
  assert.doesNotMatch(block, /review-stars|reviews-note|Все отзывы на Letterboxd/);
  assert.match(block, /el\.reviewsLink\.href/);

  const html = await readFile(new URL("../app-shell.html", import.meta.url), "utf8");
  assert.match(html, /id="reviewsLink"[^>]*>Отзывы<\/a>/);
});
