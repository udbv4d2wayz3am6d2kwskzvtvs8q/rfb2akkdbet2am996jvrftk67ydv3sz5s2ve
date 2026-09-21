import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";

const rootFile = (name) => new URL(`../${name}`, import.meta.url);

test("the Vercel document stays below the observed throttling window", async () => {
  const info = await stat(rootFile("index.html"));
  assert.ok(info.size < 10_000, `index.html is ${info.size} bytes`);

  const page = await readFile(rootFile("index.html"), "utf8");
  assert.match(page, /__ALPHY_ASSET_REV__/);
  assert.match(page, /cdn\.jsdelivr\.net\/gh\/udbv4d2wayz3am6d2kwskzvtvs8q\/rfb2akkdbet2am996jvrftk67ydv3sz5s2ve@/);
  assert.match(page, /raw\.esm\.sh\/gh\/udbv4d2wayz3am6d2kwskzvtvs8q\/rfb2akkdbet2am996jvrftk67ydv3sz5s2ve@/);
  assert.match(page, /__ALPHY_ASSET_INTEGRITY__/);
  assert.match(page, /subtle\.digest\("SHA-256"/);
  assert.doesNotMatch(page, /(?:src|href)="\/(?:app|styles|identity|catalog|foryou|keypool|shaka)/);
});

test("the shell is present before first-party scripts execute", async () => {
  const page = await readFile(rootFile("index.html"), "utf8");
  const shell = await readFile(rootFile("app-shell.html"), "utf8");
  const expectedOrder = [
    "identity.js",
    "foryou.js",
    "catalog-cache.js",
    "shaka-smooth.js",
    "app.js",
    "catalog.js",
    "keypool.js",
  ];

  assert.match(shell, /id="searchInput"/);
  assert.match(shell, /id="playerHost"/);
  assert.match(shell, /data-alphy-asset="Logo\.png"/);
  assert.match(page, /innerHTML = shellSource\.body/);

  let previous = -1;
  for (const script of expectedOrder) {
    const index = page.indexOf(`"${script}"`);
    assert.ok(index > previous, `${script} must preserve the original execution order`);
    previous = index;
  }
});

test("large lazy datasets resolve through the immutable asset base", async () => {
  const identity = await readFile(rootFile("identity.js"), "utf8");
  const app = await readFile(rootFile("app.js"), "utf8");
  const catalogCache = await readFile(rootFile("catalog-cache.js"), "utf8");

  assert.match(identity, /__alphyAssetUrl\?\.\("imdb-map\.json"\)/);
  assert.match(app, /__alphyAssetUrl\?\.\("soap-movies\.json"\)/);
  assert.match(app, /__alphyAssetUrl\?\.\("curated-fallback\.json"\)/);
  assert.match(catalogCache, /__alphyAssetUrl\?\.\("curated-fallback\.json"\)/);
});

test("the meta panel has a fixed set of children, each owning one grid cell", async () => {
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  const start = app.indexOf("// Three children, and always three");
  const render = app.slice(start, app.indexOf("el.metaPanel.dataset.watchToken", start));
  // Poster, body, credits — in that order and always all three slots, even when
  // a title has no credits. Ratings, description and credits are each optional,
  // and a grid row-span over a variable number of implicit rows does not survive
  // that: it is how the two columns used to overlap on phones.
  assert.match(render, /\$\{posterHtml\}<div class="meta-body">\$\{body\}<\/div>\$\{factsHtml\}/);
  assert.match(render, /const factsHtml = facts \? `<dl class="meta-facts">/);
  // Nothing may put the credits back inside the body.
  assert.doesNotMatch(render, /body \+= `<dl class="meta-facts"/);
  // The credits span the panel, which is what lets them run under the poster on
  // a phone instead of being squeezed into the text column beside it.
  assert.match(styles, /\.meta-facts \{\s*\n\s*grid-column: 1 \/ -1;/);
});

test("the synopsis is measured only after the panel is visible", async () => {
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const start = app.indexOf("// Revealed before the synopsis is measured");
  assert.ok(start > 0, "the ordering must stay deliberate and explained");
  const block = app.slice(start, app.indexOf("fillLetterboxdBadge", start));
  // `.hidden` is `display: none`, and a display:none element reports both
  // scrollHeight and clientHeight as 0 — so measuring first compared 0 > 2 and
  // the "ещё" toggle never appeared on a cold load.
  const reveal = block.indexOf('el.metaPanel.classList.remove("hidden")');
  const measure = block.indexOf("descNode.scrollHeight > descNode.clientHeight");
  assert.ok(reveal >= 0 && measure > reveal, "reveal has to come before the measurement");
});

test("the synopsis is cut between lines, never through one", async () => {
  const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const mobile = styles.slice(styles.indexOf("@media (max-width: 560px)"));
  // The poster's height has to be computable from its width, or the column
  // beside it has nothing to size itself against.
  assert.match(mobile, /\.meta-poster \{ width: 100%; aspect-ratio: 2 \/ 3; \}/);
  assert.match(mobile, /--meta-poster-w: clamp\(/);
  // A pixel cap on the column cut a line of letters in half. Lines are the only
  // unit that can be cut cleanly, so the count is what is computed.
  assert.doesNotMatch(mobile, /\.meta-body \{[^}]*max-height/);
  assert.match(styles, /-webkit-line-clamp: var\(--desc-lines, 6\)/);
  assert.match(app, /desc\.style\.setProperty\("--desc-lines"/);
  // A custom property, not an inline line-clamp: an inline clamp would outrank
  // `.meta-desc.open` and the expanded synopsis would stay clamped.
  assert.doesNotMatch(app, /style\.webkitLineClamp\s*=/);
  assert.match(styles, /\.meta-desc\.open \{ -webkit-line-clamp: unset/);
  // It needs real boxes, so it runs after the panel is revealed.
  const reveal = app.indexOf('el.metaPanel.classList.remove("hidden")');
  assert.ok(app.indexOf("fitMetaSynopsis();", reveal) > reveal, "measure after reveal");
  // The space left over is summed from the children. Taking it as
  // (column - synopsis) is circular: the grid stretches the column to the
  // height of the poster, so the subtraction returns whatever the synopsis
  // already was and the count never moves off its starting value.
  const fit = app.slice(app.indexOf("function fitMetaSynopsis"), app.indexOf("let fitSynopsisTimer"));
  assert.match(fit, /for \(const child of body\.children\)/);
  assert.doesNotMatch(fit, /body\.getBoundingClientRect\(\)\.height - desc/);
  assert.match(fit, /style\.position === "absolute"/);
});

test('"ещё" sits at the end of the synopsis, not on a line of its own', async () => {
  const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  const mobile = styles.slice(styles.indexOf("@media (max-width: 560px)"));
  // A row of its own plus the column gap cost a line and a half of synopsis,
  // which is most of why it used to stop so far above the bottom of the poster.
  assert.match(mobile, /\.meta-desc-toggle \{\s*\n\s*position: absolute; right: 0; bottom: 0/);
  // Out of flow, so fitMetaSynopsis does not count it against the line budget.
  assert.match(mobile, /background: linear-gradient\(to right/);
  // Expanded there is no last line to sit beside, so it returns to the flow.
  assert.match(mobile, /:has\(\.meta-desc\.open\) \.meta-desc-toggle \{\s*\n\s*position: static/);
  // And the column must take its own height, not the row's. A whole number of
  // lines rarely fills the poster exactly, and a stretched column put the
  // toggle's `bottom: 0` in the leftover below the text — 18px measured, which
  // reads as a stray word in the corner rather than the end of a sentence.
  assert.match(mobile, /\.meta-body \{ position: relative; align-self: start; \}/);
});

test("rating figures share the row instead of huddling in the middle", async () => {
  const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  const mobile = styles.slice(styles.indexOf("@media (max-width: 560px)"));
  // Equal shares, so two figures are spaced the same way three are. Centring
  // them with no gap put two almost touching and braided three together.
  assert.match(mobile, /\.meta-ratings \.rt \{ flex: 1 1 0/);
  assert.doesNotMatch(mobile, /\.meta-ratings \{[^}]*justify-content: center/);
  // Three figures — a film with a Letterboxd score — stay on one line.
  assert.match(mobile, /\.meta-ratings \{[^}]*flex-wrap: nowrap/);
});
