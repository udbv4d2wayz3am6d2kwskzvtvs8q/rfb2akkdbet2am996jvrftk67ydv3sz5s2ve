import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = () => readFile(new URL("../index.html", import.meta.url), "utf8");
const css = () => readFile(new URL("../styles.css", import.meta.url), "utf8");

test("no foreign host can hold up the first paint", async () => {
  const page = await html();
  const head = page.slice(0, page.indexOf("</head>"));
  // A cross-origin stylesheet blocks rendering until it answers. The audience
  // reaches half the internet through a filter, so one slow foreign host must
  // cost a fallback font, not a blank page.
  const blocking = [...head.matchAll(/<link\b[^>]*rel=["']stylesheet["'][^>]*>/g)]
    .map((m) => m[0])
    .filter((tag) => /https?:\/\//.test(tag))
    .filter((tag) => !/media=["']print["']/.test(tag));
  assert.deepEqual(blocking, [], "every external stylesheet must load non-blocking");
  // ...and it still becomes the real stylesheet once it lands.
  assert.match(head, /media="print" onload="this\.media='all'"/);
  // Scripts sit at the end of the body, not in the head.
  assert.doesNotMatch(head, /<script\b(?![^>]*\btype=["']application\/ld\+json["'])[^>]*\bsrc=/);
});

test("the first frame has a font to draw in", async () => {
  const sheet = await css();
  const stack = sheet.match(/font-family: 'IBM Plex Sans',([^;]+);/);
  assert.ok(stack, "the base font stack must exist");
  // system-ui alone is not a stack — it resolves to nothing on older Android
  // and some Linux builds, which is exactly where the fallback is needed.
  assert.ok(stack[1].split(",").length >= 4, "needs real fallbacks, not one word");
  assert.match(stack[1], /sans-serif\s*$/);
});

test("mobile search is a vertical three-column grid, not a two-row carousel", async () => {
  const sheet = await css();
  const mobile = sheet.slice(sheet.indexOf("@media (max-width: 560px)"));
  assert.match(mobile, /#resultsGrid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(mobile, /#resultsGrid\s*\{[\s\S]*?grid-auto-flow:\s*row/);
  assert.match(mobile, /#resultsGrid\s*\{[\s\S]*?overflow:\s*visible/);
  assert.match(mobile, /#resultsGrid\s*>\s*\.muted\s*\{[\s\S]*?grid-column:\s*1\s*\/\s*-1/);
});
