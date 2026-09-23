#!/usr/bin/env node
// Publishes the search index to jsDelivr: a base file per letter plus a small
// delta of what changed since, all content-addressed and pinned to a commit.
//
// Why: the browser used to download each letter from Supabase Storage, whose
// free egress is the first thing a few thousand daily visitors would exhaust —
// one cold load of shard п is 630 KB. jsDelivr serves the same bytes with no
// quota and, measured from Moscow and St Petersburg, faster. Supabase keeps
// only a pointer of a few hundred bytes, and its own shards stay as the
// fallback.
//
// Run by .github/workflows/search-cdn.yml in a checkout of the `search-cdn`
// branch, in three steps, because an index can only name the commit its files
// are in once that commit exists:
//
//   node publish-search-cdn.mjs data    --dir <checkout> --parts-dir <parts checkout>
//   node publish-search-cdn.mjs index   --dir <checkout> --commit <data commit> --parts-commit <parts commit>
//   node publish-search-cdn.mjs pointer --dir <checkout> --commit <index commit> --data-commit <data commit>
//
// Files never change once written, so a browser keeps a letter it already has
// until that letter's base is rebuilt. A base is rebuilt when its delta grows
// past a tenth of it (at least 200 rows), or once it is a week old; otherwise
// a changed title costs every returning visitor a few hundred bytes, not the
// whole letter again.
//
// The prefix parts of a big letter are cut from its base when the base is
// rebuilt, and the browser lays the letter's delta over them. They live on a
// branch of their own, `search-cdn-parts`: jsDelivr refuses every file of a
// commit whose tree is over 50 MB, and bases plus parts are about 70. While the
// parts were rewritten from base + delta on every run, one publish added 1,650
// files and some of them answered 403 "Package size exceeded".
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const TITLES_URL = process.env.TITLES_URL || "https://xoathqkggcuyoyutxwri.supabase.co/functions/v1/titles";
export const CDN = "https://cdn.jsdelivr.net/gh/udbv4d2wayz3am6d2kwskzvtvs8q/rfb2akkdbet2am996jvrftk67ydv3sz5s2ve@";
const DAY_MS = 24 * 3600e3;
// The base is read from the live table at t; anything committed from a moment
// before t on is shipped in the delta as well. Upserts are idempotent, so the
// overlap costs a few repeated rows and closes the gap a read in flight leaves.
const BASE_MARGIN_MS = 2 * 60e3;
export const REBASE_MIN_ROWS = 200;
export const REBASE_SHARE = 0.1;
export const PREFIX_THRESHOLD = 2000;
const foldWords = (value) => String(value || "").toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/ +/u);
export function partitionRows(rows, letter) {
  const parts = new Map();
  for (const row of rows) {
    const prefixes = new Set([...foldWords(row[0]), ...foldWords(row[6])]
      .filter((word) => word.startsWith(letter) && [...word].length >= 3)
      .map((word) => [...word].slice(0, 3).join("")));
    for (const prefix of prefixes) {
      if (!parts.has(prefix)) parts.set(prefix, []);
      parts.get(prefix).push(row);
    }
  }
  return parts;
}
const REBASE_AGE_MS = 7 * DAY_MS;
const AGE_REBASES_PER_RUN = 10;
const KEEP_INDEXES = 4;
// 2: parts on their own branch, cut from the base only. A state from before is
// re-pinned whole on its next run.
export const LAYOUT = 2;
// jsDelivr's limit is 50 MB a commit; the margin is for a catalogue that grows.
export const PACKAGE_LIMIT_BYTES = 45 * 1024 * 1024;
const WARM_CONCURRENCY = 16;
const WARM_RETRY_MS = [10_000, 30_000, 60_000, 120_000];
const READ_RETRY_MS = [5_000, 15_000, 30_000];

export const hash16 = (text) => createHash("sha256").update(text).digest("hex").slice(0, 16);
export const codepoint = (letter) => letter.codePointAt(0).toString(16);
const single = (letter) => typeof letter === "string" && [...letter].length === 1;

export async function readJsonWithRetry(url, { auth = false, token = "", fetcher = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), waits = READ_RETRY_MS } = {}) {
  let failure;
  for (let attempt = 0; attempt <= waits.length; attempt += 1) {
    let response;
    try {
      response = await fetcher(url, {
        headers: auth ? { "x-publish-token": token } : {},
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      failure = error;
    }
    if (response?.ok) {
      try { return await response.json(); }
      catch (error) { failure = error; }
    } else if (response) {
      failure = new Error(`${new URL(url).pathname} ${response.status}`);
      if (![502, 503, 504].includes(response.status)) throw failure;
    }
    if (attempt === waits.length) throw failure;
    await sleep(waits[attempt]);
  }
  throw failure;
}

// Network, replaced in tests.
export const net = {
  token: process.env.PUBLISH_TOKEN || "",
  async get(url, { auth = false } = {}) {
    return readJsonWithRetry(url, { auth, token: net.token });
  },
  async post(url, body) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "x-publish-token": net.token, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`${new URL(url).pathname} ${response.status} ${await response.text()}`);
    return response.json();
  },
  now: () => Date.now(),
};

async function changesSince(start) {
  const rows = [];
  let cursor = { after_at: start.after_at, after_id: Number(start.after_id) || 0 };
  while (cursor) {
    const page = await net.get(`${TITLES_URL}/changes?after_at=${encodeURIComponent(cursor.after_at)}&after_id=${cursor.after_id}`, { auth: true });
    rows.push(...page.rows);
    cursor = page.next;
  }
  return rows;
}

// Folds what changed since the last run into a letter's delta. Rows are kept
// as the seven fields a shard row carries, one per title — the newest — and a
// title that comes back to a letter is no longer removed from it.
export function mergeDelta(previous, letter, since, changes, removed) {
  const upserts = new Map((previous?.u || []).map((row) => [row[2], row]));
  const removes = new Set(previous?.r || []);
  const events = [
    ...changes.filter((row) => Array.isArray(row[7]) && row[7].includes(letter) && row[8] > since)
      .map((row) => ({ at: row[8], slug: row[2], row: row.slice(0, 7) })),
    ...removed.filter((entry) => entry.letter === letter && entry.removed_at > since)
      .map((entry) => ({ at: entry.removed_at, slug: entry.slug, row: null })),
  ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  for (const event of events) {
    if (event.row) {
      upserts.set(event.slug, event.row);
      removes.delete(event.slug);
    } else {
      upserts.delete(event.slug);
      removes.add(event.slug);
    }
  }
  const u = [...upserts.values()].sort((a, b) => (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0));
  return { u, r: [...removes].sort() };
}

export const needsRebase = (entry, delta) =>
  delta.u.length + delta.r.length > Math.max(REBASE_MIN_ROWS, REBASE_SHARE * (entry?.n || 0));

async function readState(dir) {
  try {
    return JSON.parse(await readFile(path.join(dir, "state.json"), "utf8"));
  } catch {
    return { v: 1, letters: {}, cursor: null, index: null, indexes: [] };
  }
}

async function readJson(dir, name) {
  try {
    return JSON.parse(await readFile(path.join(dir, name), "utf8"));
  } catch {
    return null;
  }
}

async function writeFileOnce(dir, name, body) {
  const file = path.join(dir, name);
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await readFile(file);
    return false;
  } catch {
    await writeFile(file, body);
    return true;
  }
}

// What a commit of this tree would weigh, as jsDelivr counts it.
async function treeBytes(root) {
  let total = 0;
  for (const folder of ["b", "d", "i", "p"]) {
    let names = [];
    try { names = await readdir(path.join(root, folder)); } catch { names = []; }
    for (const name of names) total += (await stat(path.join(root, folder, name))).size;
  }
  return total;
}

export async function buildData(dir, { partsDir = dir, limitBytes = PACKAGE_LIMIT_BYTES, log = console.log } = {}) {
  const state = await readState(dir);
  const now = net.now();
  // A release from before layout 2 named parts in this tree, and bases and
  // deltas in commits jsDelivr may refuse. Every file is pinned again, to
  // commits it can serve; the file names stay, so browsers keep their copies.
  const migrate = Object.keys(state.letters || {}).length > 0 && state.layout !== LAYOUT;
  const { letters } = await net.get(`${TITLES_URL}/letters`, { auth: true });
  const wanted = [...new Set(letters.filter(single))];

  // Only what changed since the previous run is read. The first run has no
  // cursor: every letter is based on the live table and the cursor starts at
  // the earliest base, so nothing between the reads is missed.
  const cursor = state.cursor;
  const changes = cursor ? await changesSince(cursor) : [];
  const removed = cursor
    ? (await net.get(`${TITLES_URL}/removed?since=${encodeURIComponent(cursor.after_at)}`, { auth: true })).removed
    : [];

  const plans = [];
  for (const letter of wanted) {
    const cp = codepoint(letter);
    const entry = state.letters[cp];
    const previous = entry?.d ? await readJson(dir, entry.d) : null;
    const delta = entry ? mergeDelta(previous, letter, entry.s, changes, removed) : null;
    const stale = entry && now - Date.parse(entry.rebased) > REBASE_AGE_MS;
    plans.push({ letter, cp, entry, delta, rebase: !entry || needsRebase(entry, delta), stale });
  }
  // A week-old base is refreshed a few letters at a time, not all at once.
  let aged = 0;
  for (const plan of plans.filter((item) => !item.rebase && item.stale)) {
    if (aged >= AGE_REBASES_PER_RUN) break;
    plan.rebase = true;
    aged += 1;
  }

  const next = {};
  let rebased = 0;
  let written = 0;
  let earliestBase = null;
  let partsWritten = 0;
  for (const plan of plans) {
    let entry = plan.entry;
    let delta = plan.delta;
    let baseRows = null;
    if (plan.rebase) {
      const startedAt = net.now();
      const rows = await net.get(`${TITLES_URL}?i=${encodeURIComponent(plan.letter)}`);
      if (!Array.isArray(rows)) throw new Error(`base ${plan.letter}: not rows`);
      const body = JSON.stringify(rows);
      const file = `b/${plan.cp}.${hash16(body)}.json`;
      if (await writeFileOnce(dir, file, body)) written += 1;
      const s = new Date(startedAt - BASE_MARGIN_MS).toISOString();
      if (!earliestBase || s < earliestBase) earliestBase = s;
      entry = {
        letter: plan.letter,
        b: file,
        bc: plan.entry?.b === file && !migrate ? plan.entry.bc : "pending",
        n: rows.length,
        s,
        rebased: new Date(startedAt).toISOString(),
      };
      baseRows = rows;
      // What changed while the base was being read is shipped on top of it.
      delta = mergeDelta(null, plan.letter, s, changes, removed);
      rebased += 1;
    } else if (migrate) {
      entry = { ...entry, bc: "pending" };
    }
    let d = null;
    let dc = null;
    if (delta.u.length || delta.r.length) {
      const body = JSON.stringify(delta);
      d = `d/${plan.cp}.${hash16(body)}.json`;
      if (await writeFileOnce(dir, d, body)) written += 1;
      dc = plan.entry?.d === d && !migrate ? plan.entry.dc : "pending";
    }
    // Parts follow the base, not the delta: between rebuilds a changed title
    // touches the delta file alone, however many prefixes it is filed under.
    const wantParts = entry.n >= PREFIX_THRESHOLD;
    let parts = plan.rebase || migrate ? null : plan.entry?.parts || null;
    if (wantParts && !parts) {
      parts = {};
      for (const [prefix, values] of partitionRows(baseRows || await readJson(dir, entry.b), plan.letter)) {
        const body = JSON.stringify(values);
        const file = `p/${hash16(body)}.json`;
        if (await writeFileOnce(partsDir, file, body)) partsWritten += 1;
        const old = plan.entry?.parts?.[prefix];
        parts[prefix] = [file, old?.[0] === file && !migrate ? old[1] : "pending", values.length];
      }
    } else if (!wantParts) {
      parts = null;
    }
    next[plan.cp] = { letter: entry.letter, b: entry.b, bc: entry.bc, n: entry.n, s: entry.s, rebased: entry.rebased, d, dc, parts };
  }

  // Only what the new state names stays in the tree. Everything removed is
  // still in the history and in jsDelivr's permanent cache, so a browser that
  // read an older index keeps working.
  const referenced = new Set(Object.values(next).flatMap((entry) => [entry.b, entry.d, ...Object.values(entry.parts || {}).map((p) => p[0])]).filter(Boolean));
  const keepIndexes = new Set((state.indexes || []).slice(-KEEP_INDEXES));
  const trees = partsDir === dir ? [[dir, ["b", "d", "i", "p"]]] : [[dir, ["b", "d", "i", "p"]], [partsDir, ["p"]]];
  for (const [root, folders] of trees) {
    for (const folder of folders) {
      let names = [];
      try { names = await readdir(path.join(root, folder)); } catch { names = []; }
      for (const name of names) {
        const file = `${folder}/${name}`;
        // A separate parts tree means no part belongs in the data tree.
        const keep = folder === "i" ? keepIndexes.has(file)
          : folder === "p" && root !== partsDir ? false
            : referenced.has(file);
        if (!keep) await rm(path.join(root, file));
      }
    }
  }
  const sizes = [];
  for (const [root] of trees) {
    const bytes = await treeBytes(root);
    sizes.push(`${path.basename(root)} ${(bytes / 1048576).toFixed(1)} MB`);
    // Better a failed run than a release jsDelivr answers with 403 file by file.
    if (bytes > limitBytes) throw new Error(`${root} would commit ${(bytes / 1048576).toFixed(1)} MB; jsDelivr refuses a commit over 50 MB`);
  }
  const last = changes[changes.length - 1];
  state.cursor = last
    ? { after_at: last[8], after_id: last[9] }
    : cursor || { after_at: earliestBase || new Date(now - BASE_MARGIN_MS).toISOString(), after_id: 0 };
  state.layout = LAYOUT;
  state.letters = next;
  state.updated = new Date(now).toISOString();
  await writeFile(path.join(dir, "state.json"), `${JSON.stringify(state, null, 1)}\n`);
  const deltas = Object.values(next).filter((entry) => entry.d).length;
  log(`letters ${wanted.length}, rebased ${rebased}${migrate ? " (layout migration)" : ""}, deltas ${deltas}, new files ${written}, new parts ${partsWritten}, changes read ${changes.length}; ${sizes.join(", ")}`);
  return { rebased, written, partsWritten, migrated: migrate, letters: wanted.length, deltas, changes: changes.length };
}

// `partsCommit` is the head of the parts branch; with no separate parts tree it
// is the data commit itself.
export async function buildIndex(dir, commit, partsCommit = commit) {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("index needs the data commit");
  const state = await readState(dir);
  const l = {};
  let freshParts = false;
  for (const cp of Object.keys(state.letters).sort()) {
    const entry = state.letters[cp];
    if (entry.bc === "pending") entry.bc = commit;
    if (entry.dc === "pending") entry.dc = commit;
    l[cp] = [entry.b, entry.bc, entry.n, entry.d, entry.dc];
    if (entry.parts) {
      for (const part of Object.values(entry.parts)) {
        if (part[1] !== "pending") continue;
        if (!/^[0-9a-f]{40}$/.test(partsCommit)) throw new Error("index needs the parts commit");
        part[1] = partsCommit;
        freshParts = true;
      }
      const partBody = JSON.stringify(entry.parts);
      const partFile = `i/${hash16(partBody)}.json`;
      await writeFileOnce(dir, partFile, partBody);
      // Manifest is in the INDEX commit, supplied by the pointer to the client.
      l[cp].push(partFile);
    }
  }
  const body = JSON.stringify({ v: 1, at: state.updated, l });
  const file = `i/${hash16(body)}.json`;
  await writeFileOnce(dir, file, body);
  state.index = file;
  state.dataCommit = commit;
  // Which parts this release added, so only those are warmed.
  state.partsCommit = freshParts ? partsCommit : null;
  state.indexes = [...(state.indexes || []).filter((name) => name !== file), file].slice(-KEEP_INDEXES);
  await writeFile(path.join(dir, "state.json"), `${JSON.stringify(state, null, 1)}\n`);
  return file;
}

// Each new file is requested once through jsDelivr before any browser is told
// about it, so the first visitor after a publish does not pay the trip to GitHub.
export async function warmAndPoint(dir, commit, dataCommit, {
  fetcher = fetch, log = console.log, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const state = await readState(dir);
  const urls = [`${CDN}${commit}/${state.index}`];
  const index = await readJson(dir, state.index);
  for (const entry of Object.values(state.letters)) {
    if (entry.bc === dataCommit) urls.push(`${CDN}${entry.bc}/${entry.b}`);
    if (entry.d && entry.dc === dataCommit) urls.push(`${CDN}${entry.dc}/${entry.d}`);
    const manifest = index.l[codepoint(entry.letter)]?.[5];
    if (manifest) urls.push(`${CDN}${commit}/${manifest}`);
    for (const part of Object.values(entry.parts || {})) {
      if (state.partsCommit && part[1] === state.partsCommit) urls.push(`${CDN}${part[1]}/${part[0]}`);
    }
  }
  const total = new Set(urls).size;
  let pending = [...new Set(urls)];
  let reason = "";
  log(`warming ${total} unique files`);
  // A miss is retried twice: jsDelivr's first trip to GitHub for a new commit
  // sometimes times out, and a file that failed once is usually there a minute later.
  for (let pass = 0; pending.length && pass <= WARM_RETRY_MS.length; pass += 1) {
    if (pass) {
      log(`retrying ${pending.length} files after ${WARM_RETRY_MS[pass - 1] / 1000}s; first failure: ${reason}`);
      await sleep(WARM_RETRY_MS[pass - 1]);
    }
    const failed = [];
    for (let at = 0; at < pending.length; at += WARM_CONCURRENCY) {
      await Promise.all(pending.slice(at, at + WARM_CONCURRENCY).map(async (url) => {
        try {
          const response = await fetcher(url, { signal: AbortSignal.timeout(60_000) });
          const body = await response.text();
          if (!response.ok) {
            failed.push(url);
            reason ||= `${response.status} ${body.slice(0, 90)} (${url})`;
          }
        } catch (error) {
          failed.push(url);
          reason ||= `${error.name || error.message} (${url})`;
        }
      }));
      const done = at + WARM_CONCURRENCY;
      if (done % 512 === 0) log(`pass ${pass + 1}: ${Math.min(done, pending.length)}/${pending.length}; failures ${failed.length}`);
    }
    pending = failed;
  }
  // A file jsDelivr could not serve must not be announced.
  if (pending.length) throw new Error(`${pending.length} of ${total} files are not on jsDelivr yet; first failure: ${reason}`);
  const result = await net.post(`${TITLES_URL}/pointer`, { c: commit, f: state.index });
  log(`warmed ${total} files; pointer -> ${commit.slice(0, 12)} ${state.index}`);
  return result;
}

// A failed warm happens after the data branch was pushed. Finish that release
// before building another one, including when the source has not changed.
export async function resumePublication(dir, commit, dataCommit, options) {
  const state = await readState(dir);
  // A layout-1 release is not finished but replaced: its commits are over
  // jsDelivr's limit, and the data step pins everything anew.
  if (!state.index || state.layout !== LAYOUT) return false;
  const pointerUrl = new URL("/storage/v1/object/public/index/pointer.json", TITLES_URL);
  pointerUrl.searchParams.set("publish_check", String(net.now()));
  let pointer = null;
  try { pointer = await net.get(pointerUrl.href); }
  catch (error) { if (!/\s404$/.test(error.message)) throw error; }
  if (pointer?.c === commit && pointer?.f === state.index) return false;
  await warmAndPoint(dir, commit, state.dataCommit || dataCommit, options);
  return true;
}

function argument(name) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : "";
}

async function main() {
  const step = process.argv[2];
  const dir = path.resolve(argument("dir") || ".");
  if (!net.token) throw new Error("PUBLISH_TOKEN is required");
  const partsDir = argument("parts-dir") ? path.resolve(argument("parts-dir")) : dir;
  if (step === "data") await buildData(dir, { partsDir });
  else if (step === "index") {
    // Given but empty means the parts branch has no commit: pending parts then fail loudly.
    const partsCommit = process.argv.includes("--parts-commit") ? argument("parts-commit") : argument("commit");
    console.log(await buildIndex(dir, argument("commit"), partsCommit));
  }
  else if (step === "pointer") await warmAndPoint(dir, argument("commit"), argument("data-commit"));
  else if (step === "resume") await resumePublication(dir, argument("commit"), argument("data-commit"));
  else throw new Error("step must be data, index or pointer");
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
