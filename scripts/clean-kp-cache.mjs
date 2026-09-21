#!/usr/bin/env node
// Keeps the current and previous immutable slots, and a film's newest card for
// as long as the broker may still carry it forward (RENEW_MS): that card is what
// spares the provider call when a rarely opened old film is asked for again.
// No catalogues, identities, admin documents or legacy v1 rollback objects are
// ever deletion candidates.
import { pathToFileURL } from "node:url";
import { objectSlot, OBJECT_HOSTS, RENEW_MS } from "../supabase/functions/kp/index.ts";

const OBJECT_RE = /^v2\/(film|staff|similars|search)\/([1-9]\d{0,14})\/(\d+)\.json$/;
const groupOf = (name) => { const match = OBJECT_RE.exec(name); return match ? `${match[1]}/${match[2]}` : name; };

export function expiredObject(name, now = Date.now()) {
  const match = OBJECT_RE.exec(name);
  return !!match && Number(match[3]) < objectSlot(match[1], match[2], now) - 1;
}

// Every expired object in `names`, which must hold each title's objects whole.
export function deletableObjects(names, now = Date.now()) {
  const newest = new Map();
  for (const name of names) {
    const match = OBJECT_RE.exec(name);
    if (match) newest.set(groupOf(name), Math.max(newest.get(groupOf(name)) ?? -1, Number(match[3])));
  }
  return names.filter((name) => {
    if (!expiredObject(name, now)) return false;
    const [, kind, id, slot] = OBJECT_RE.exec(name);
    const carriable = kind === "film" && Number(slot) === newest.get(groupOf(name))
      && Number(slot) >= objectSlot(kind, id, now - RENEW_MS) - 1;
    return !carriable;
  });
}

async function main() {
  const keys = JSON.parse(process.env.KP_STORAGE_KEYS || "{}");
  const dryRun = process.argv.includes("--dry-run");
  const deadline = Date.now() + 12 * 60e3;
  for (const ref of OBJECT_HOSTS) {
    if (!keys[ref]) throw new Error(`Missing service key for ${ref}`);
    const call = async (path, body, method = "POST") => {
      const r = await fetch(`https://${ref}.supabase.co${path}`, {
        method, headers: { apikey: keys[ref], Authorization: `Bearer ${keys[ref]}`, "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
      });
      if (!r.ok) throw new Error(`maintenance ${ref}: HTTP ${r.status}`);
      return r.json();
    };
    let after = "", scanned = 0, expired = 0, held = [];
    while (true) {
      if (Date.now() >= deadline) throw new Error("maintenance time budget exceeded; resume next run");
      const page = await call("/rest/v1/rpc/kp_object_page", { p_after: after, p_limit: 500 });
      if (!Array.isArray(page)) throw new Error("invalid object page");
      let names = held.concat(page.map((row) => row.name));
      // A title's objects are adjacent in name order, but a page can split them:
      // its last title waits for the next page before its newest card is judged.
      held = [];
      if (page.length) {
        let cut = names.length;
        while (cut > 0 && groupOf(names[cut - 1]) === groupOf(names.at(-1))) cut -= 1;
        held = names.slice(cut);
        names = names.slice(0, cut);
      }
      const prefixes = deletableObjects(names);
      if (prefixes.length && !dryRun) await call("/storage/v1/object/kp", { prefixes }, "DELETE");
      scanned += page.length; expired += prefixes.length;
      if (!page.length) break;
      after = page.at(-1).name;
    }
    console.log(`${ref}: scanned ${scanned}, ${dryRun ? "would delete" : "deleted"} ${expired}`);
    if (!dryRun && ref === OBJECT_HOSTS[0]) console.log("state:", await call("/rest/v1/rpc/kp_prune_state", {}));
  }
}
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
