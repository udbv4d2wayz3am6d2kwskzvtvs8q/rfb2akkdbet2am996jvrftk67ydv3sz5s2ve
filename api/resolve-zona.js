import worker from "../worker/src/index.js";

const env = {
  ALLOWED_ORIGIN:
    "https://alphytv.vercel.app,https://alphy.tv,https://www.alphy.tv,http://127.0.0.1:5177,http://localhost:5177",
};

export default async function handler(req, res) {
  if (!["GET", "OPTIONS"].includes(req.method || "GET")) {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, OPTIONS");
    res.end("Method Not Allowed");
    return;
  }

  const host = req.headers.host || "alphy.tv";
  const protocol = req.headers["x-forwarded-proto"] || "https";
  const incomingUrl = new URL(req.url || "/api/resolve-zona", `${protocol}://${host}`);
  const workerUrl = new URL("/resolve-zona", incomingUrl.origin);
  workerUrl.search = incomingUrl.search;

  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else if (value != null) headers.set(name, String(value));
  }

  const response = await worker.fetch(new Request(workerUrl, {
    method: req.method,
    headers,
  }), env);
  const body = await response.text();

  res.statusCode = response.status;
  response.headers.forEach((value, name) => {
    if (name.toLowerCase() !== "content-length") res.setHeader(name, value);
  });

  let resolved = false;
  try {
    const data = JSON.parse(body);
    resolved = response.ok && data?.ok && !!data.embedUrl;
  } catch {
    resolved = false;
  }

  if (resolved) {
    // kpId -> Zenith mappings are stable. Vercel's CDN is the persistent free
    // cache layer even when Deno KV is not attached to the project.
    res.setHeader("Cache-Control", "public, max-age=0, s-maxage=2592000, stale-while-revalidate=86400");
    res.setHeader("CDN-Cache-Control", "public, max-age=2592000");
  } else {
    res.setHeader("Cache-Control", "no-store");
  }
  res.end(body);
}
