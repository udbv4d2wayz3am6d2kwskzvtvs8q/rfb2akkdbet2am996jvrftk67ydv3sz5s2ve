import {
  importLegacyKeys,
  readKeyPool,
  runtimePool,
  runtimeTokenMatches,
} from "../_key-pool-store.js";

const MAX_BODY_BYTES = 80 * 1024;

function bearer(req) {
  return String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
}

async function readBody(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string") return req.body ? JSON.parse(req.body) : {};
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY_BYTES) throw new Error("request_too_large");
  }
  return body ? JSON.parse(body) : {};
}

function send(res, body, status = 200) {
  res.statusCode = status;
  res.setHeader("Cache-Control", "no-store, private");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(JSON.stringify(body));
}

export default async function handler(req, res) {
  if (!["GET", "POST"].includes(req.method || "")) {
    res.setHeader("Allow", "GET, POST");
    send(res, { ok: false, error: "method_not_allowed" }, 405);
    return;
  }

  try {
    let { pool, exists } = await readKeyPool();
    if (!exists) {
      send(res, { ok: false, error: "key_pool_not_initialized" }, 503);
      return;
    }
    if (!runtimeTokenMatches(pool, bearer(req))) {
      send(res, { ok: false, error: "runtime_auth_required" }, 401);
      return;
    }

    let imported = 0;
    if (req.method === "POST") {
      const payload = await readBody(req);
      const result = await importLegacyKeys(payload?.legacyKeys);
      pool = result.pool;
      imported = result.imported;
    }
    send(res, { ok: true, imported, pool: runtimePool(pool) });
  } catch (error) {
    console.error("[key-pool-runtime]", error?.code || error?.message || String(error));
    send(res, { ok: false, error: "runtime_pool_failed" }, 500);
  }
}
