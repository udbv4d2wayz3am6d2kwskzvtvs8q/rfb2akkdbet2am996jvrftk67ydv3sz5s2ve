#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_INPUTS = [
  path.join(ROOT, "var", "collaps-4k", "collaps-4k.json"),
  path.join(ROOT, "var", "collaps-4k-popular", "collaps-4k.json"),
];
const DEFAULT_OUT_DIR = path.join(ROOT, "var", "collaps-4k-all");

function compact(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function tsvCell(value) {
  return compact(value).replace(/[\t\r\n]+/g, " ");
}

function sanitizeQuality(value) {
  if (!value || !Number.isFinite(Number(value.height))) return null;
  const optionalNumber = (field) => field !== null && field !== undefined && field !== "" && Number.isFinite(Number(field))
    ? Number(field)
    : null;
  return {
    key: compact(value.key) || null,
    label: compact(value.label) || null,
    height: Number(value.height),
    season: optionalNumber(value.season),
    episode: optionalNumber(value.episode),
    voiceStudio: compact(value.voiceStudio) || null,
    voiceType: compact(value.voiceType) || null,
  };
}

function sanitizeItem(value, catalog) {
  const kpId = /^\d+$/.test(String(value?.kpId || "")) ? String(value.kpId) : null;
  const title = compact(value?.title);
  const quality = sanitizeQuality(value?.quality);
  if (!kpId || !title || !quality || quality.height <= 1080) return null;
  return {
    kpId,
    title,
    year: Number.isFinite(Number(value.year)) ? Number(value.year) : null,
    isSeries: !!value.isSeries,
    status: "confirmed_high_res",
    sources: [...new Set((Array.isArray(value.sources) ? value.sources : []).map(compact).filter(Boolean))],
    catalogs: [catalog],
    quality,
    coverage: value.coverage && typeof value.coverage === "object" ? {
      complete: !!value.coverage.complete,
      totalUnique: Number(value.coverage.totalUnique || 0),
      queued: Number(value.coverage.queued || 0),
      sampledEpisodes: Number(value.coverage.sampledEpisodes || 0),
      mode: compact(value.coverage.mode) || null,
    } : null,
    completedAt: compact(value.completedAt) || null,
  };
}

export function mergeCollapsResults(inputs) {
  const byKp = new Map();
  let inputItems = 0;
  let acceptedItems = 0;
  for (const input of inputs) {
    const catalog = compact(input.catalog) || "input";
    for (const raw of (Array.isArray(input.items) ? input.items : [])) {
      inputItems += 1;
      const item = sanitizeItem(raw, catalog);
      if (!item) continue;
      acceptedItems += 1;
      const previous = byKp.get(item.kpId);
      if (!previous) {
        byKp.set(item.kpId, item);
        continue;
      }
      const preferred = item.quality.height > previous.quality.height ? item : previous;
      preferred.sources = [...new Set([...previous.sources, ...item.sources])];
      preferred.catalogs = [...new Set([...previous.catalogs, ...item.catalogs])];
      preferred.year ||= previous.year || item.year;
      byKp.set(item.kpId, preferred);
    }
  }
  const items = [...byKp.values()].sort((a, b) =>
    Number(b.quality.height) - Number(a.quality.height) ||
    Number(a.isSeries) - Number(b.isSeries) ||
    a.title.localeCompare(b.title, "ru"));
  const summary = {
    inputItems,
    acceptedItems,
    uniqueItems: items.length,
    duplicateItems: acceptedItems - items.length,
    excludedItems: inputItems - acceptedItems,
    movies: items.filter((item) => !item.isSeries).length,
    series: items.filter((item) => item.isSeries).length,
    byQuality: Object.fromEntries([...new Set(items.map((item) => item.quality.label || `${item.quality.height}p`))]
      .sort()
      .map((label) => [label, items.filter((item) => (item.quality.label || `${item.quality.height}p`) === label).length])),
  };
  return { summary, items };
}

async function readInput(filePath) {
  const data = JSON.parse(await fs.readFile(filePath, "utf8"));
  return {
    catalog: path.basename(path.dirname(filePath)),
    items: Array.isArray(data) ? data : data.items,
  };
}

async function writeAtomic(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  await fs.writeFile(temp, text, { mode: 0o600 });
  await fs.rename(temp, filePath);
}

export async function writeMergedOutputs(inputs, outDir = DEFAULT_OUT_DIR) {
  const result = mergeCollapsResults(inputs);
  const generatedAt = new Date().toISOString();
  const titles = result.items.map((item) => item.title).join("\n") + (result.items.length ? "\n" : "");
  const details = ["title\tyear\ttype\tquality\tkpId\tcatalogs", ...result.items.map((item) => [
    item.title,
    item.year || "",
    item.isSeries ? "series" : "movie",
    item.quality.label || `${item.quality.height}p`,
    item.kpId,
    item.catalogs.join(","),
  ].map(tsvCell).join("\t"))].join("\n") + "\n";
  const payload = { generatedAt, summary: result.summary, items: result.items };
  await Promise.all([
    writeAtomic(path.join(outDir, "collaps-4k.json"), JSON.stringify(payload, null, 2) + "\n"),
    writeAtomic(path.join(outDir, "collaps-4k-titles.txt"), titles),
    writeAtomic(path.join(outDir, "collaps-4k-details.tsv"), details),
    writeAtomic(path.join(outDir, "summary.json"), JSON.stringify({ generatedAt, ...result.summary }, null, 2) + "\n"),
  ]);
  return { generatedAt, ...result.summary, outDir };
}

function parseArgs(argv) {
  let inputPaths = DEFAULT_INPUTS;
  let outDir = DEFAULT_OUT_DIR;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--input") {
      inputPaths = String(argv[++index] || "").split(",").map((value) => path.resolve(value.trim())).filter(Boolean);
    } else if (token === "--out-dir") {
      outDir = path.resolve(argv[++index] || "");
    } else if (token === "--help" || token === "-h") {
      return { help: true, inputPaths, outDir };
    } else {
      throw new Error(`Unknown argument ${token}`);
    }
  }
  if (!inputPaths.length) throw new Error("At least one --input file is required");
  return { help: false, inputPaths, outDir };
}

export async function main(argv = process.argv.slice(2)) {
  const config = parseArgs(argv);
  if (config.help) {
    process.stdout.write("Merge sanitized Collaps scan outputs\n\n  npm run collaps4k:merge -- --input first.json,second.json --out-dir var/collaps-4k-all\n");
    return;
  }
  const inputs = await Promise.all(config.inputPaths.map(readInput));
  const summary = await writeMergedOutputs(inputs, config.outDir);
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main().catch((error) => {
    process.stderr.write(`FAILED: ${error.message}\n`);
    process.exitCode = 1;
  });
}
