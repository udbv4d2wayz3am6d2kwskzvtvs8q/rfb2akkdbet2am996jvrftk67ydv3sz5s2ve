#!/usr/bin/env node
// One-time copy before deploying the new admin endpoints. Never removes the
// source; a repeated run is safe and verifies ciphertext by decrypting in RAM.
import { createHash } from "node:crypto";
import { readDocument, writeDocument } from "../api/_document-store.js";
import { decryptPool } from "../api/_key-pool-store.js";
const sources = {
  catalog: process.env.ALPHY_LEGACY_CATALOG_URL,
  key_pool: process.env.ALPHY_LEGACY_KEY_POOL_URL,
};
// Versioned catalogues are authoritative after the first versioned admin save.
// Only a missing manifest permits the old stable snapshot as a fallback.
if (process.env.ALPHY_LEGACY_CATALOG_POINTER) {
  const pointerUrl = new URL(process.env.ALPHY_LEGACY_CATALOG_POINTER);
  pointerUrl.searchParams.set("migration", String(Date.now()));
  const r = await fetch(pointerUrl, { cache: "no-store", signal: AbortSignal.timeout(15000) });
  if (r.ok) {
    const pointer = await r.json();
    const target = new URL(pointer.blobUrl);
    if (target.protocol !== "https:" || target.origin !== pointerUrl.origin) throw new Error("invalid legacy catalogue pointer");
    sources.catalog = target.href;
  } else if (r.status !== 404) throw new Error(`legacy catalogue pointer unavailable: ${r.status}`);
}
const hash = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const stable = (v) => Array.isArray(v) ? v.map(stable) : v && typeof v === "object"
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])])) : v;
for (const [name, source] of Object.entries(sources)) {
  if (!source) throw new Error(`Missing legacy URL for ${name}`);
  const r = await fetch(`${source}?migration=${Date.now()}`, { cache: "no-store", signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`${name} source unavailable: ${r.status}`);
  const payload = await r.json();
  const clear = name === "key_pool" ? decryptPool(payload) : payload;
  if (clear.schema !== 1 || !Number.isInteger(clear.revision)) throw new Error(`${name}: invalid document`);
  if (name === "catalog" && !Array.isArray(clear.lists)) throw new Error("invalid catalogue");
  if (name === "key_pool" && (!Array.isArray(clear.keys) || !clear.runtimeToken)) throw new Error("invalid key pool");
  const current = await readDocument(name);
  if (current && current.revision > clear.revision) throw new Error(`${name}: destination is newer; refusing to regress`);
  if (!current || hash(stable(current.payload)) !== hash(stable(payload))) {
    await writeDocument(name, payload, current?.revision || 0, clear.revision);
  }
  const after = await readDocument(name);
  // Postgres JSONB may reorder keys, so compare canonical JSON recursively.
  if (hash(stable(after?.payload)) !== hash(stable(payload))) throw new Error(`${name}: verification failed`);
  console.log(`${name}: revision ${clear.revision}, ${name === "catalog" ? clear.lists.length + " lists" : clear.keys.length + " keys"}, verified`);
}
