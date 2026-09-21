#!/usr/bin/env node
// Provisions the shared Kinopoisk cache (supabase/functions/kp).
//
//   KP_TOKENS='{"<ref>":"sbp_…", …}' [KU_KEYS='k1,k2,…'] node scripts/deploy-kp-broker.mjs
//
//  - applies schema.sql to the state project (the first object host);
//  - makes a public, JSON-only `kp` bucket on every object host;
//  - sets the function's secrets on the state project: the other hosts'
//    service keys (so it can publish there) and, when given, the Unofficial
//    keys it spends;
//  - deploys without platform JWT verification; the function checks its own
//    private resolver/prewarm token. Browsers cannot spend quota directly.
//
// Every token and key comes from the environment and is sent only to Supabase.
// Nothing is written to disk.
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { OBJECT_HOSTS, BUCKET } from "../supabase/functions/kp/index.ts";

const tokens = JSON.parse(process.env.KP_TOKENS || "{}");
const stateRef = OBJECT_HOSTS[0];
if (!process.env.KP_BROKER_TOKEN || process.env.KP_BROKER_TOKEN.length < 32) throw new Error("KP_BROKER_TOKEN must be configured before deployment");
for (const ref of OBJECT_HOSTS) {
  if (!/^sbp_[A-Za-z0-9]+$/.test(String(tokens[ref] || ""))) throw new Error(`no management token for ${ref}`);
}

async function management(ref, path, init = {}) {
  const response = await fetch(`https://api.supabase.com/v1/projects/${ref}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${tokens[ref]}`, "Content-Type": "application/json", ...(init.headers || {}) },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${ref} ${path}: ${response.status} ${text.replace(/\s+/g, " ").slice(0, 240)}`);
  return text ? JSON.parse(text) : null;
}

async function serviceKey(ref) {
  const keys = await management(ref, "/api-keys");
  const key = keys.find((entry) => entry.name === "service_role" && entry.type === "legacy")?.api_key;
  if (!key) throw new Error(`${ref}: no service_role key`);
  return key;
}

const schema = await readFile(new URL("../supabase/functions/kp/schema.sql", import.meta.url), "utf8");
await management(stateRef, "/database/query", { method: "POST", body: JSON.stringify({ query: schema }) });
console.log(`schema ready on ${stateRef}`);

const hostKeys = {};
const maintenance = await readFile(new URL("../supabase/kp-maintenance.sql", import.meta.url), "utf8");
for (const ref of OBJECT_HOSTS) {
  await management(ref, "/database/query", { method: "POST", body: JSON.stringify({ query: maintenance }) });
  const key = await serviceKey(ref);
  if (ref !== stateRef) hostKeys[ref] = key;
  const bucket = {
    id: BUCKET, name: BUCKET, public: true,
    file_size_limit: 262144, allowed_mime_types: ["application/json"],
  };
  const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  let response = await fetch(`https://${ref}.supabase.co/storage/v1/bucket`, {
    method: "POST", headers, body: JSON.stringify(bucket), signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok && /already exists|Duplicate/i.test(await response.text())) {
    response = await fetch(`https://${ref}.supabase.co/storage/v1/bucket/${BUCKET}`, {
      method: "PUT", headers, body: JSON.stringify(bucket), signal: AbortSignal.timeout(20_000),
    });
  }
  if (!response.ok) throw new Error(`${ref}: bucket ${response.status}`);
  console.log(`public bucket ${BUCKET} ready on ${ref}`);
}

const secrets = [{ name: "KP_HOST_KEYS", value: JSON.stringify(hostKeys) },
  { name: "KP_BROKER_TOKEN", value: process.env.KP_BROKER_TOKEN }];
if (process.env.ALPHY_KEY_POOL_TOKEN) secrets.push({ name: "ALPHY_KEY_POOL_TOKEN", value: process.env.ALPHY_KEY_POOL_TOKEN });
const kuKeys = String(process.env.KU_KEYS || "").split(",").map((value) => value.trim()).filter(Boolean);
if (kuKeys.length) secrets.push({ name: "KU_KEYS", value: kuKeys.join(",") });
await management(stateRef, "/secrets", { method: "POST", body: JSON.stringify(secrets) });
console.log(`secrets set on ${stateRef}: ${secrets.map((secret) => secret.name).join(", ")}` +
  (kuKeys.length ? ` (${kuKeys.length} Unofficial keys)` : ""));

execFileSync("supabase", ["functions", "deploy", "kp", "--project-ref", stateRef, "--no-verify-jwt"], {
  cwd: new URL("..", import.meta.url).pathname,
  env: { ...process.env, SUPABASE_ACCESS_TOKEN: tokens[stateRef] },
  stdio: "inherit",
});
console.log(`function kp deployed to ${stateRef}`);
