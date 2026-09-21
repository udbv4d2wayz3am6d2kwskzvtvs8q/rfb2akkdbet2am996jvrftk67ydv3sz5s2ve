#!/usr/bin/env node
// Additive provisioning only: copies no data and changes no running services.
// Run migration afterwards, then deploy backends before switching the browser.
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";
const ref = process.env.ALPHY_STATE_REF;
const token = process.env.SUPABASE_ACCESS_TOKEN;
const output = process.env.ALPHY_PREPARED_ENV || ".env.scaling";
if (!/^[a-z]{20}$/.test(ref || "") || !token) throw new Error("ALPHY_STATE_REF and SUPABASE_ACCESS_TOKEN required");
async function management(path, init = {}) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${ref}${path}`, {
    ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(`management ${path}: HTTP ${r.status}`);
  return r.json();
}
const keys = await management("/api-keys");
const key = keys.find((item) => item.name === "service_role")?.api_key;
if (!key) throw new Error("No service role key on state project");
await management("/database/query", { method: "POST", body: JSON.stringify({ query: await readFile("supabase/admin-documents.sql", "utf8") }) });
const base = `https://${ref}.supabase.co`;
const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
const bucket = { id: "provider-cache", name: "provider-cache", public: false, file_size_limit: 16384, allowed_mime_types: ["application/json"] };
let r = await fetch(`${base}/storage/v1/bucket`, { method: "POST", headers, body: JSON.stringify(bucket), signal: AbortSignal.timeout(15000) });
if (!r.ok && /already exists|Duplicate/i.test(await r.text())) r = await fetch(`${base}/storage/v1/bucket/provider-cache`, { method: "PUT", headers, body: JSON.stringify(bucket), signal: AbortSignal.timeout(15000) });
if (!r.ok) throw new Error(`provider-cache bucket: HTTP ${r.status}`);
let existing = {};
try { existing = parseEnv(await readFile(output, "utf8")); } catch { /* first run */ }
const values = { ...existing, ALPHY_STATE_URL: base, ALPHY_STATE_SERVICE_KEY: key,
  ALPHY_CACHE_URL: base, ALPHY_CACHE_SERVICE_KEY: key,
  KP_BROKER_TOKEN: existing.KP_BROKER_TOKEN || process.env.KP_BROKER_TOKEN || randomBytes(32).toString("hex") };
await writeFile(output, Object.entries(values).map(([name, value]) => {
  if (/[\r\n']/.test(value)) throw new Error(`Unsupported environment value for ${name}`);
  return `${name}='${value}'`;
}).join("\n") + "\n", { mode: 0o600 });
console.log(`Private document table and provider cache ready on ${ref}; configuration saved to ${output}. No deployment switched.`);
