import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { makeSandbox, sleep } from "./helpers/app-sandbox.js";
import {
  buildData, buildIndex, mergeDelta, needsRebase, net, codepoint, partitionRows, warmAndPoint, resumePublication,
} from "../scripts/publish-search-cdn.mjs";

// The search index moved from Supabase Storage to jsDelivr: a tiny pointer on
// Supabase, an index and per-letter base + delta files pinned to a commit.
// These pin that a browser gets the same rows either way, that it falls back to
// Supabase when the new path cannot answer, and that the publisher ships small
// deltas and only rebuilds a letter when its delta has grown.

const plain = (value) => JSON.parse(JSON.stringify(value));
const ok = (body) => ({ ok: true, status: 200, headers: { get: () => "" }, json: async () => body });
const missing = () => ({ ok: false, status: 404, headers: { get: () => "" }, json: async () => ({}) });
const C1 = "a".repeat(40);
const C2 = "b".repeat(40);

// [name, year, slug, isSeries, embedId, kp, originName]
const row = (name, year, slug, kp = "") => [name, year, slug, 0, 1, kp, ""];

async function boot(files) {
  const ctx = makeSandbox();
  ctx.run();
  await sleep(80);
  const asked = [];
  ctx.sandbox.fetch = async (url) => {
    const href = String(url);
    asked.push(href);
    const answer = typeof files === "function" ? files(href) : files[href];
    return answer === undefined ? missing() : ok(answer);
  };
  return { app: ctx.sandbox.window.alphyBridge._test, asked };
}

const POINTER = "https://xoathqkggcuyoyutxwri.supabase.co/storage/v1/object/public/index/pointer.json";
const cdn = (commit, file) => `https://cdn.jsdelivr.net/gh/udbv4d2wayz3am6d2kwskzvtvs8q/rfb2akkdbet2am996jvrftk67ydv3sz5s2ve@${commit}/${file}`;
const P = "43f"; // п

test("prefix partitions preserve matching at any word in either language", async () => {
  const rows = [
    ["Пираты Карибского моря", 2003, "pirates", 0, 1, "4374", "Pirates of the Caribbean"],
    ["Пи", 1998, "pi", 0, 2, "1", "Pi"],
    ["Пираты. Пиратский фильм", 2026, "p", 0, 3, "2", ""],
  ];
  const parts = partitionRows(rows, "п");
  assert.equal(parts.get("пир").length, 2, "multiple matching words never duplicate the title");
  assert.equal(partitionRows(rows, "к").get("кар")[0][2], "pirates");
  assert.equal(partitionRows(rows, "c").get("car")[0][2], "pirates");
});

test("a cold long prefix downloads its small partition, never the giant letter", async () => {
  const entry = [`b/${P}.1111111111111111.json`, C1, 20000, null, null, "i/3333333333333333.json"];
  const { app, asked } = await boot({
    [POINTER]: { v: 1, c: C2, f: "i/0123456789abcdef.json" },
    [cdn(C2, "i/0123456789abcdef.json")]: { v: 1, l: { [P]: entry } },
    [cdn(C2, "i/3333333333333333.json")]: { пир: ["p/4444444444444444.json", C1, 1] },
    [cdn(C1, "p/4444444444444444.json")]: [row("Пираты", 2003, "piraty")],
  });
  assert.equal((await app.loadSearchRows("пираты"))[0][2], "piraty");
  assert.ok(asked.every((url) => !url.includes("/b/") && !url.includes("/index/v3/")));
});

test("the letter's delta is laid over a part by the rule the part was cut by", async () => {
  const entry = [`b/${P}.1111111111111111.json`, C1, 20000, `d/${P}.2222222222222222.json`, C2, "i/3333333333333333.json"];
  const renamed = ["Пекло", 2026, "was-pirate", 0, 1, "", "Hell"];
  const { app, asked } = await boot({
    [POINTER]: { v: 1, c: C2, f: "i/0123456789abcdef.json" },
    [cdn(C2, "i/0123456789abcdef.json")]: { v: 1, l: { [P]: entry } },
    [cdn(C2, "i/3333333333333333.json")]: { пир: ["p/4444444444444444.json", C1, 3] },
    [cdn(C1, "p/4444444444444444.json")]: [
      row("Пираты", 2003, "piraty"), row("Пирамида", 2014, "gone"), ["Старое имя", 1, "was-pirate", 0, 1, "", "Пир"],
    ],
    [cdn(C2, `d/${P}.2222222222222222.json`)]: {
      u: [row("Пираты", 2003, "piraty", "4374"), ["The Pier", 2026, "pier", 0, 1, "", "Пирс"], renamed],
      r: ["gone"],
    },
  });
  const rows = plain(await app.loadSearchRows("пир"));
  assert.deepEqual(rows.map((r) => r[2]).sort(), ["pier", "piraty"],
    "a removal leaves, an original-title word files a new row, a renamed row leaves the prefix");
  assert.equal(rows.find((r) => r[2] === "piraty")[5], "4374", "the delta's version of a title wins");
  assert.ok(asked.every((url) => !url.includes("/b/")), "still without the giant letter");
});

test("a delta replaces titles by slug, drops the ones that left, and adds the new", async () => {
  const { app } = await boot({});
  const base = [row("Пираты", 2003, "piraty"), row("Паразиты", 2019, "parazity"), row("Побег", 1994, "pobeg")];
  const merged = app.applySearchDelta(base, {
    u: [row("Пираты", 2003, "piraty", "4374"), row("Пекло", 2026, "peklo")],
    r: ["pobeg"],
  });
  assert.deepEqual(plain(merged).map((r) => r[2]).sort(), ["parazity", "peklo", "piraty"]);
  assert.equal(plain(merged).find((r) => r[2] === "piraty")[5], "4374");
  assert.equal(app.applySearchDelta(base, null), base, "no delta, the base itself");
});

test("a letter is read from jsDelivr: pointer, index, base and delta, and never from the Supabase shard", async () => {
  const index = { v: 1, l: { [P]: [`b/${P}.1111111111111111.json`, C1, 2, `d/${P}.2222222222222222.json`, C1] } };
  const files = {
    [POINTER]: { v: 1, c: C2, f: "i/0123456789abcdef.json" },
    [cdn(C2, "i/0123456789abcdef.json")]: index,
    [cdn(C1, `b/${P}.1111111111111111.json`)]: [row("Пираты", 2003, "piraty"), row("Побег", 1994, "pobeg")],
    [cdn(C1, `d/${P}.2222222222222222.json`)]: { u: [row("Пекло", 2026, "peklo")], r: ["pobeg"] },
  };
  const { app, asked } = await boot(files);
  const rows = plain(await app.loadShard("п"));
  assert.deepEqual(rows.map((r) => r[2]).sort(), ["peklo", "piraty"]);
  assert.ok(!asked.some((url) => url.includes("/object/public/index/v3/")), "the old shard must not be fetched");
  // Matching on the merged letter works exactly as before.
  assert.equal(plain(app.matchShard(rows, "пекло"))[0].slug, "peklo");
});

test("a file jsDelivr cannot serve is read from the same commit on rawcdn.githack, not from Supabase", async () => {
  const githack = (commit, file) => `https://rawcdn.githack.com/udbv4d2wayz3am6d2kwskzvtvs8q/rfb2akkdbet2am996jvrftk67ydv3sz5s2ve/${commit}/${file}`;
  const index = { v: 1, l: { [P]: [`b/${P}.1111111111111111.json`, C1, 1, null, null] } };
  const { app, asked } = await boot({
    [POINTER]: { v: 1, c: C2, f: "i/0123456789abcdef.json" },
    [cdn(C2, "i/0123456789abcdef.json")]: index,
    // The base is missing on jsDelivr (404 from the fake), present on githack.
    [githack(C1, `b/${P}.1111111111111111.json`)]: [row("Пираты", 2003, "piraty")],
  });
  const rows = plain(await app.loadShard("п"));
  assert.equal(rows[0][2], "piraty");
  assert.ok(asked.includes(cdn(C1, `b/${P}.1111111111111111.json`)), "jsDelivr is asked first");
  assert.ok(asked.includes(githack(C1, `b/${P}.1111111111111111.json`)));
  assert.ok(!asked.includes(githack(C2, "i/0123456789abcdef.json")), "a file jsDelivr served is not asked again elsewhere");
  assert.ok(!asked.some((url) => url.includes("/index/v3/")), "Supabase is not needed while the reserve answers");
});

test("when the pointer cannot be read, the Supabase shard serves as before", async () => {
  const supabaseShard = `https://xoathqkggcuyoyutxwri.supabase.co/storage/v1/object/public/index/v3/${P}.json`;
  const { app, asked } = await boot({ [supabaseShard]: [row("Пираты", 2003, "piraty")] });
  const rows = plain(await app.loadShard("п"));
  assert.equal(rows[0][2], "piraty");
  assert.ok(asked.includes(POINTER));
  assert.ok(asked.includes(supabaseShard));
});

test("a letter in memory answers at once, and a moved pointer swaps in the newer rows", async () => {
  let pointer = { v: 1, c: C2, f: "i/0000000000000001.json" };
  const files = (url) => ({
    [POINTER]: pointer,
    [cdn(C2, "i/0000000000000001.json")]: { v: 1, l: { [P]: [`b/${P}.aaaaaaaaaaaaaaaa.json`, C1, 1, null, null] } },
    [cdn(C2, "i/0000000000000002.json")]: { v: 1, l: { [P]: [`b/${P}.aaaaaaaaaaaaaaaa.json`, C1, 1, `d/${P}.bbbbbbbbbbbbbbbb.json`, C2] } },
    [cdn(C1, `b/${P}.aaaaaaaaaaaaaaaa.json`)]: [row("Пираты", 2003, "piraty")],
    [cdn(C2, `d/${P}.bbbbbbbbbbbbbbbb.json`)]: { u: [row("Пекло", 2026, "peklo")], r: [] },
  })[url];
  const { app, asked } = await boot(files);
  assert.equal(plain(await app.loadShard("п")).length, 1);

  pointer = { v: 1, c: C2, f: "i/0000000000000002.json" };
  await app.currentSearchPointer({ force: true });
  const before = asked.length;
  assert.equal(plain(await app.loadShard("п")).length, 1, "the keystroke is answered from memory");
  await sleep(30);
  assert.equal(plain(await app.loadShard("п")).length, 2, "and the next one sees the new title");
  assert.ok(!asked.slice(before).some((url) => url.includes(`b/${P}.aaaaaaaaaaaaaaaa.json`)),
    "an unchanged base is never downloaded again");
});

test("equal score and year are ordered by title, whatever order the letter holds them in", async () => {
  const { app } = await boot({});
  const rows = [row("Пекло", 2020, "b"), row("Пекло", 2020, "a"), row("Пекло 2", 2020, "c"), row("Пекло", 2020, "d")];
  const reversed = [...rows].reverse();
  const first = plain(app.matchShard(rows, "пекло")).map((entry) => entry.title);
  const second = plain(app.matchShard(reversed, "пекло")).map((entry) => entry.title);
  assert.deepEqual(first, second);
});

// --- the publisher -----------------------------------------------------------

test("changes fold into a letter's delta: newest row wins, removal and return both count", () => {
  const since = "2026-09-11T10:00:00.000Z";
  const changes = [
    ["Пекло", 2026, "peklo", 0, 1, "", "", ["п"], "2026-09-11T10:05:00.000Z", 1],
    ["Пекло", 2026, "peklo", 0, 1, "999", "Hell", ["п", "h"], "2026-09-11T10:06:00.000Z", 1],
    ["Старое", 1990, "old", 0, 1, "", "", ["с"], "2026-09-11T10:07:00.000Z", 2],
    ["Раньше", 1990, "early", 0, 1, "", "", ["п"], "2026-09-11T09:00:00.000Z", 3],
  ];
  const removed = [
    { letter: "п", slug: "gone", removed_at: "2026-09-11T10:08:00.000Z" },
    { letter: "п", slug: "back", removed_at: "2026-09-11T10:01:00.000Z" },
  ];
  const later = [["Назад", 2001, "back", 0, 1, "", "", ["п"], "2026-09-11T10:09:00.000Z", 4]];
  const delta = mergeDelta({ u: [row("Прежнее", 2000, "kept")], r: [] }, "п", since, [...changes, ...later], removed);
  assert.deepEqual(delta.u.map((r) => r[2]), ["back", "kept", "peklo"]);
  assert.equal(delta.u.find((r) => r[2] === "peklo")[5], "999", "the newest version of a title");
  assert.equal(delta.u.find((r) => r[2] === "peklo").length, 7, "only the fields a shard row carries");
  assert.deepEqual(delta.r, ["gone"]);
});

test("a letter is rebuilt only once its delta outgrows a tenth of it", () => {
  const small = { u: Array(150).fill(row("x", 1, "x")), r: [] };
  assert.equal(needsRebase({ n: 19000 }, small), false);
  assert.equal(needsRebase({ n: 1000 }, { u: Array(201).fill(0), r: [] }), true);
  assert.equal(needsRebase({ n: 19000 }, { u: Array(1901).fill(0), r: [] }), true);
});

function fakeTitles({ letters, bases, changes = [], removed = [] }) {
  const calls = [];
  let clock = Date.parse("2026-09-11T12:00:00Z");
  net.token = "t";
  net.now = () => { clock += 1000; return clock; };
  net.get = async (url) => {
    calls.push(url);
    const u = new URL(url);
    if (u.pathname.endsWith("/letters")) return { letters };
    if (u.pathname.endsWith("/changes")) {
      const after = u.searchParams.get("after_at");
      return { rows: changes.filter((c) => c[8] > after), next: null };
    }
    if (u.pathname.endsWith("/removed")) return { removed };
    return bases[u.searchParams.get("i")];
  };
  return { calls };
}

test("the publisher's first run bases every letter; later runs ship deltas and move the cursor", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "search-cdn-"));
  try {
    const bases = { п: [row("Пираты", 2003, "piraty")], к: [row("Коко", 2017, "koko")] };
    const first = fakeTitles({ letters: ["п", "к", "i̇"], bases });
    const summary = await buildData(dir, { log: () => {} });
    assert.equal(summary.rebased, 2, "a letter that is not one character is skipped");
    const state = JSON.parse(await readFile(path.join(dir, "state.json"), "utf8"));
    assert.equal(state.letters[codepoint("п")].bc, "pending");
    assert.ok(state.cursor?.after_at, "the cursor starts at the earliest base");
    assert.ok(!first.calls.some((url) => url.includes("/changes")), "nothing to read before a base exists");

    const indexFile = await buildIndex(dir, C1);
    const index = JSON.parse(await readFile(path.join(dir, indexFile), "utf8"));
    assert.equal(index.l[codepoint("п")][1], C1, "pending files are pinned to the data commit");

    // An hour later one title in п changed.
    const at = new Date(Date.parse(state.cursor.after_at) + 3600e3).toISOString();
    fakeTitles({
      letters: ["п", "к"],
      bases,
      changes: [["Пираты", 2003, "piraty", 0, 1, "4374", "Pirates", ["п"], at, 10]],
    });
    const second = await buildData(dir, { log: () => {} });
    assert.equal(second.rebased, 0);
    assert.equal(second.deltas, 1);
    const next = JSON.parse(await readFile(path.join(dir, "state.json"), "utf8"));
    assert.equal(next.letters[codepoint("к")].d, null, "an untouched letter carries no delta");
    const delta = JSON.parse(await readFile(path.join(dir, next.letters[codepoint("п")].d), "utf8"));
    assert.equal(delta.u[0][5], "4374");
    assert.equal(next.letters[codepoint("п")].dc, "pending");
    assert.equal(next.letters[codepoint("п")].bc, C1, "the base keeps its commit, so browsers keep their copy");
    assert.deepEqual(next.cursor, { after_at: at, after_id: 10 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a delta that outgrows its letter triggers a rebuild, and the old files leave the tree", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "search-cdn-"));
  try {
    fakeTitles({ letters: ["к"], bases: { к: [row("Коко", 2017, "koko")] } });
    await buildData(dir, { log: () => {} });
    await buildIndex(dir, C1);
    const state = JSON.parse(await readFile(path.join(dir, "state.json"), "utf8"));
    const oldBase = state.letters[codepoint("к")].b;

    const at = new Date(Date.parse(state.cursor.after_at) + 60e3).toISOString();
    const many = Array.from({ length: 250 }, (_, i) => [`К ${i}`, 2020, `k-${i}`, 0, 1, "", "", ["к"], at, 100 + i]);
    const fresh = Array.from({ length: 251 }, (_, i) => row(`К ${i}`, 2020, `k-${i}`));
    fakeTitles({ letters: ["к"], bases: { к: fresh }, changes: many });
    const summary = await buildData(dir, { log: () => {} });
    assert.equal(summary.rebased, 1);
    const next = JSON.parse(await readFile(path.join(dir, "state.json"), "utf8"));
    assert.notEqual(next.letters[codepoint("к")].b, oldBase);
    assert.equal(next.letters[codepoint("к")].n, 251);
    const bases = await readdir(path.join(dir, "b"));
    assert.deepEqual(bases, [path.basename(next.letters[codepoint("к")].b)], "the replaced base is removed from the tree");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the search publisher workflow commits data before the index that names it", async () => {
  const workflow = await readFile(new URL("../.github/workflows/search-cdn.yml", import.meta.url), "utf8");
  const data = workflow.indexOf("publish-search-cdn.mjs data");
  const partsPush = workflow.indexOf("HEAD:search-cdn-parts");
  const index = workflow.indexOf("publish-search-cdn.mjs index");
  const pointer = workflow.indexOf("publish-search-cdn.mjs pointer");
  assert.ok(data > 0 && partsPush > data && index > partsPush && pointer > index);
  assert.match(workflow, /--parts-dir parts/);
  assert.match(workflow, /--parts-commit "\$parts_commit"/);
  assert.match(workflow, /SEARCH_PUBLISH_TOKEN/);
  assert.doesNotMatch(workflow, /force/i, "history is appended, never rewritten: old commits stay readable");
});

// jsDelivr answers 403 "Package size exceeded" for files of a commit whose tree
// is over 50 MB. Bases alone are 35 MB and parts another 32, so parts get a
// tree of their own, and they are cut when the base is — not on every delta,
// which once added 1,650 files to a single hourly publish.
const bigLetter = (count, extra = []) => Array.from({ length: count }, (_, i) => [`Коко ${i}`, 2017, `koko-${i}`, 0, i + 1, "", i % 2 ? "Coco" : ""]).concat(extra);

test("parts are cut from the base into their own tree, and a delta alone leaves them untouched", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "search-data-"));
  const partsDir = await mkdtemp(path.join(os.tmpdir(), "search-parts-"));
  const P3 = "c".repeat(40);
  const oldPost = net.post;
  try {
    fakeTitles({ letters: ["к"], bases: { к: bigLetter(2001) } });
    const first = await buildData(dir, { partsDir, log: () => {} });
    assert.ok(first.partsWritten > 0);
    assert.deepEqual((await readdir(dir)).sort(), ["b", "state.json"], "no part in the data tree");
    assert.ok((await readdir(path.join(partsDir, "p"))).length > 0);
    await buildIndex(dir, C1, C2);
    const state = JSON.parse(await readFile(path.join(dir, "state.json"), "utf8"));
    assert.equal(state.layout, 2);
    assert.equal(state.partsCommit, C2);
    assert.ok(Object.values(state.letters[codepoint("к")].parts).every((part) => part[1] === C2), "parts are pinned to the parts commit");
    assert.equal(state.letters[codepoint("к")].bc, C1);

    const at = new Date(Date.parse(state.cursor.after_at) + 60e3).toISOString();
    fakeTitles({ letters: ["к"], bases: {}, changes: [["Коко 1", 2017, "koko-1", 0, 2, "301", "Coco", ["к", "c"], at, 50]] });
    const partsBefore = await readdir(path.join(partsDir, "p"));
    const second = await buildData(dir, { partsDir, log: () => {} });
    assert.equal(second.rebased, 0);
    assert.equal(second.partsWritten, 0, "a changed title touches the delta file alone");
    assert.deepEqual(await readdir(path.join(partsDir, "p")), partsBefore);
    await buildIndex(dir, P3, "");
    const next = JSON.parse(await readFile(path.join(dir, "state.json"), "utf8"));
    assert.equal(next.partsCommit, null, "nothing new in the parts tree, nothing of it to warm");
    assert.equal(next.letters[codepoint("к")].dc, P3);

    const warmed = [];
    net.post = async () => ({ ok: true });
    await warmAndPoint(dir, "d".repeat(40), P3, { fetcher: async (url) => { warmed.push(url); return new Response("{}"); }, log: () => {} });
    assert.ok(!warmed.some((url) => url.includes("/p/")), "parts already warmed are not fetched again");
    assert.ok(warmed.some((url) => url.includes("/d/")));
  } finally {
    net.post = oldPost;
    await rm(dir, { recursive: true, force: true });
    await rm(partsDir, { recursive: true, force: true });
  }
});

test("a layout-1 release is re-pinned whole, and its parts leave the data tree", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "search-data-"));
  const partsDir = await mkdtemp(path.join(os.tmpdir(), "search-parts-"));
  try {
    fakeTitles({ letters: ["к", "л"], bases: { к: bigLetter(2001), л: [row("Лес", 2001, "les")] } });
    await buildData(dir, { log: () => {} });
    await buildIndex(dir, C1);
    const old = JSON.parse(await readFile(path.join(dir, "state.json"), "utf8"));
    delete old.layout;
    await writeFile(path.join(dir, "state.json"), JSON.stringify(old));
    assert.ok((await readdir(path.join(dir, "p"))).length > 0, "layout 1 kept parts beside the bases");
    assert.equal(await resumePublication(dir, C2, C1, { fetcher: () => assert.fail("a layout-1 release is not resumed"), log: () => {} }), false);

    fakeTitles({ letters: ["к", "л"], bases: {} });
    const summary = await buildData(dir, { partsDir, log: () => {} });
    assert.equal(summary.migrated, true);
    assert.equal(summary.rebased, 0, "no base is read again");
    const state = JSON.parse(await readFile(path.join(dir, "state.json"), "utf8"));
    assert.ok(Object.values(state.letters).every((entry) => entry.bc === "pending"), "every base is pinned anew");
    assert.ok(Object.values(state.letters[codepoint("к")].parts).every((part) => part[1] === "pending"));
    assert.deepEqual(await readdir(path.join(dir, "p")), [], "the data tree sheds its parts");
    assert.ok((await readdir(path.join(partsDir, "p"))).length > 0);
    await assert.rejects(buildIndex(dir, C2, ""), /parts commit/, "pending parts cannot be pinned to no commit");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(partsDir, { recursive: true, force: true });
  }
});

test("a tree jsDelivr would refuse fails the run instead of the release", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "search-data-"));
  try {
    fakeTitles({ letters: ["к"], bases: { к: bigLetter(50) } });
    await assert.rejects(buildData(dir, { limitBytes: 100, log: () => {} }), /over 50 MB/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed CDN warm resumes the same release before a new snapshot can replace it", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "search-resume-"));
  const oldGet = net.get, oldPost = net.post;
  try {
    const samePart = Array.from({ length: 2001 }, (_, i) => ["Коко", 2017, `koko-${i}`, 0, i + 1, "", "Coco"]);
    fakeTitles({ letters: ["к", "c"], bases: { к: samePart, c: samePart } });
    await buildData(dir, { log: () => {} });
    const index = await buildIndex(dir, C1);
    let pointed = 0, published = null;
    net.post = async (url, value) => { pointed += 1; published = value; return { ok: true }; };
    const tried = [];
    await assert.rejects(warmAndPoint(dir, C2, C1, {
      fetcher: async (url) => { tried.push(url); return new Response("Package size exceeded", { status: 403 }); },
      log: () => {}, sleep: async () => {},
    }), /not on jsDelivr yet; first failure: 403 Package size exceeded/);
    assert.equal(tried.length, 3 * new Set(tried).size, "every failed file is tried three times, not more");
    assert.equal(pointed, 0, "failed files are never announced");
    net.get = async () => published;
    const asked = [];
    const options = { fetcher: async (url) => { asked.push(url); return new Response("{}"); }, log: () => {} };
    assert.equal(await resumePublication(dir, C2, C1, options), true);
    assert.equal(pointed, 1);
    assert.equal(published.f, index);
    assert.equal(asked.length, new Set(asked).size);
    assert.equal(asked.filter((url) => url.includes("/p/")).length, 1, "identical Russian/original-title partitions are warmed once");
    assert.equal(await resumePublication(dir, C2, C1, { fetcher: () => assert.fail("already published"), log: () => {} }), false);
  } finally { net.get = oldGet; net.post = oldPost; await rm(dir, { recursive: true, force: true }); }
});
