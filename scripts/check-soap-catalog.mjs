import fs from "node:fs";

const catalogPath = new URL("../soap-movies.json", import.meta.url);
const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
const movies = Array.isArray(catalog.movies) ? catalog.movies.filter((m) => m?.m) : [];
const timeoutMs = Number(process.env.SOAP_CHECK_TIMEOUT_MS || 8000);
const concurrency = Math.max(1, Number(process.env.SOAP_CHECK_CONCURRENCY || 4));
const scope = process.env.SOAP_CHECK_SCOPE || "sample";
const defaultLimit = scope === "sample" ? 20 : 0;
const limit = Number(process.env.SOAP_CHECK_LIMIT || defaultLimit);
const minOkRatio = Number(process.env.SOAP_CHECK_MIN_OK_RATIO || 1);
const diagnostics = process.env.SOAP_CHECK_DIAG === "1";

function isPriorityMovie(movie) {
  return movie?.q === "4K" || Number(movie?.w || 0) > 1920 || Number(movie?.h || 0) > 1080;
}

function orderedMovies() {
  const priority = movies.filter(isPriorityMovie);
  const rest = movies.filter((movie) => !isPriorityMovie(movie));
  if (scope === "priority") return priority;
  if (scope === "all") return [...priority, ...rest];
  return [...priority, ...rest];
}

const ordered = orderedMovies();
const sample = limit > 0 ? ordered.slice(0, limit) : ordered;

async function checkMovie(movie, extraHeaders = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(movie.m, {
      cache: "no-store",
      credentials: "omit",
      headers: {
        "accept": "*/*",
        "accept-encoding": "identity",
        "user-agent": "Mozilla/5.0 (compatible; AlphyCatalogCheck/1.0)",
        ...extraHeaders,
      },
      mode: "cors",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
    const { text, error } = await readProbe(response);
    const contentType = response.headers.get("content-type") || "";
    const contentLength = response.headers.get("content-length") || "";
    const ok = response.ok && /#EXTM3U/i.test(text) && /#EXT-X-STREAM-INF/i.test(text);
    return {
      id: movie.id,
      title: movie.t,
      quality: movie.q,
      ok,
      status: response.status,
      message: ok
        ? ""
        : [
          error ? `body ${error}` : "",
          contentType ? `type=${contentType}` : "",
          contentLength ? `len=${contentLength}` : "",
          text ? text.slice(0, 80).replace(/\s+/g, " ") : "",
        ].filter(Boolean).join(" "),
    };
  } catch (error) {
    return {
      id: movie.id,
      title: movie.t,
      quality: movie.q,
      ok: false,
      status: 0,
      message: `${error.name}: ${error.message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function readProbe(response) {
  if (!response.body?.getReader) {
    try {
      return { text: await response.text(), error: "" };
    } catch (error) {
      return { text: "", error: `${error.name}: ${error.message}` };
    }
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length < 65536) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (/#EXTM3U/i.test(text) && /#EXT-X-STREAM-INF/i.test(text)) break;
    }
    text += decoder.decode();
    return { text, error: "" };
  } catch (error) {
    return { text, error: `${error.name}: ${error.message}` };
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }
}

async function runPool(items, worker) {
  const results = [];
  let next = 0;
  async function runWorker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runWorker));
  return results;
}

if (!sample.length) {
  console.error(`No SOAP movie masters found for scope=${scope} in soap-movies.json`);
  process.exit(1);
}

const results = await runPool(sample, checkMovie);
const failed = results.filter((item) => !item.ok);
const ok = results.length - failed.length;
const ratio = ok / results.length;

console.log(`SOAP catalog check: ${ok}/${results.length} manifests OK (scope=${scope}, priority=${movies.filter(isPriorityMovie).length}, generated=${catalog.generated || "?"})`);
for (const item of failed.slice(0, 12)) {
  console.log(`FAIL ${item.status || "ERR"} id=${item.id} q=${item.quality} "${item.title}" ${item.message}`);
}
if (diagnostics && failed.length) {
  for (const failedItem of failed.slice(0, 3)) {
    const movie = sample.find((item) => item.id === failedItem.id);
    if (!movie) continue;
    const variants = [
      ["origin", { "origin": "https://alphy.tv" }],
      ["alphyRef", { "referer": "https://alphy.tv/" }],
      ["soapRef", { "referer": "https://soap4youand.me/movies/" }],
    ];
    const checked = [];
    for (const [name, headers] of variants) {
      const result = await checkMovie(movie, headers);
      checked.push(`${name}=${result.ok ? "ok" : result.status || "ERR"}`);
    }
    console.log(`DIAG id=${failedItem.id} ${checked.join(" ")}`);
  }
}
if (ratio < minOkRatio) {
  console.log("Refresh soap-movies.json before deploying SOAP movies.");
  process.exit(1);
}
