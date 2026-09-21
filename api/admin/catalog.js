import { requireAdmin } from "../_admin-auth.js";
import { readCatalog, writeCatalog } from "../_catalog-versioned-store.js";

async function readBody(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string") return req.body ? JSON.parse(req.body) : {};
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 600_000) throw new Error("request_too_large");
  }
  return body ? JSON.parse(body) : {};
}

export default async function handler(req, res) {
  if (!["GET", "PUT"].includes(req.method || "")) {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, PUT");
    res.end("Method Not Allowed");
    return;
  }
  if (!requireAdmin(req, res)) return;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  try {
    if (req.method === "GET") {
      const result = await readCatalog();
      res.end(JSON.stringify({ ok: true, ...result }));
      return;
    }

    const payload = await readBody(req);
    const expectedRevision = Number(payload?.baseRevision);
    const result = await writeCatalog(
      payload?.catalog,
      Number.isInteger(expectedRevision) ? expectedRevision : null,
    );
    res.end(JSON.stringify({ ok: true, ...result }));
  } catch (error) {
    if (error?.code === "catalog_revision_conflict") {
      res.statusCode = 409;
      res.end(JSON.stringify({ ok: false, error: error.code, ...error.current }));
      return;
    }
    if (error?.code === "catalog_too_large" || error?.message === "request_too_large") {
      res.statusCode = 413;
      res.end(JSON.stringify({ ok: false, error: error.code || error.message }));
      return;
    }
    console.error("[catalog]", error?.code || error?.message || String(error));
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: "catalog_storage_failed" }));
  }
}
