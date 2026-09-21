// How many distinct addresses do we actually have to work with?
//
// Reads supabase/functions/egress on every project we run and reports the set of
// outbound IPs, grouped by project and by region.
//
// Measured 2026-09-10, and the answer was not the one the question assumed:
//   Supabase Edge  36 calls -> 36 distinct IPv4, one per cold isolate, spanning
//                  ~11 /16s per project out of a shared AWS eu-central-1 pool.
//                  The projects' /16s overlap, so it is ONE pool and a single
//                  project already gets the whole rotation — the cluster of
//                  accounts is not what buys it. (The IPv6 side is the opposite:
//                  one shared 2a05:d014:61b:2708::/62 for every project. Only
//                  matters for a target with AAAA; hdrzk.org has none.)
//   Deno Deploy    24 parallel calls -> 1 isolate, 1 address (78.141.210.166,
//                  region ams). One fixed identity for every viewer we have.
//
//   node scripts/measure-egress.mjs [--rounds=8] [--deno]
//
// --deno also probes the Deno resolver's health endpoint, so the run records
// which host the comparison was made against.

const args = new Map(process.argv.slice(2)
  .filter((a) => a.startsWith("--"))
  .map((a) => a.replace(/^--/, "").split("=")));

// Every project the site talks to today. Shards live on the first; the rest
// carry the liftw and Letterboxd relays.
const PROJECTS = [
  "xoathqkggcuyoyutxwri",
  "icmjgvlsyfqwyewvsuje",
  "gzwynsvcydynqidwxjru",
  "cuyofxgofmhdugauoqzt",
  "hrtnvhafwzimjstvegno",
  "pvwrwsnzqaldyuvlttlv",
];

// Cold isolates are where a different NAT address would show up, if it ever
// does. A handful of back-to-back calls mostly reuses one warm instance, so the
// rounds are spaced and the isolate id is recorded to keep the two apart.
const ROUNDS = Number(args.get("rounds") || 8);
const SPACING_MS = 700;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probe(ref) {
  const url = `https://${ref}.supabase.co/functions/v1/egress?t=${Date.now()}${Math.random()}`;
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) return { error: `http ${response.status}` };
    return await response.json();
  } catch (error) {
    return { error: String(error?.message || error).slice(0, 80) };
  }
}

const seen = new Map();   // ref -> { ips:Set, isolates:Set, region, errors:[] }
for (const ref of PROJECTS) seen.set(ref, { ips: new Set(), isolates: new Set(), region: "", errors: [] });

for (let round = 0; round < ROUNDS; round += 1) {
  const results = await Promise.all(PROJECTS.map(probe));
  results.forEach((result, index) => {
    const entry = seen.get(PROJECTS[index]);
    if (result.error) { entry.errors.push(result.error); return; }
    entry.region ||= result.region || "";
    if (result.isolate) entry.isolates.add(result.isolate);
    for (const value of Object.values(result.ip || {})) {
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value) || value.includes(":")) entry.ips.add(value);
      else entry.errors.push(value);
    }
  });
  process.stdout.write(`round ${round + 1}/${ROUNDS}\r`);
  if (round + 1 < ROUNDS) await sleep(SPACING_MS);
}

console.log("\n");
const everything = new Set();
for (const [ref, entry] of seen) {
  for (const ip of entry.ips) everything.add(ip);
  const ips = [...entry.ips];
  console.log(`${ref}  region=${entry.region || "?"}  isolates=${entry.isolates.size}`);
  console.log(`   ips (${ips.length}): ${ips.join(", ") || "(none)"}`);
  if (entry.errors.length) {
    const unique = [...new Set(entry.errors)];
    console.log(`   problems: ${unique.slice(0, 3).join(" | ")}${unique.length > 3 ? ` (+${unique.length - 3})` : ""}`);
  }
}

const reporting = [...seen.values()].filter((entry) => entry.ips.size);
console.log(`\ndistinct addresses across ${reporting.length} reporting projects: ${everything.size}`);
console.log([...everything].map((ip) => `  ${ip}`).join("\n"));

// The verdict this run exists to produce.
if (everything.size === 0) {
  // Nothing answered. Almost always the function is not deployed yet — say so
  // rather than reporting "one address", which is what an all-404 run looks like
  // if you only count the set.
  console.log("\n=> No address observed at all. Deploy the probe first:");
  console.log("   for r in " + PROJECTS.join(" ") + "; do \\");
  console.log("     supabase functions deploy egress --project-ref $r --no-verify-jwt; done");
} else if (everything.size === 1) {
  console.log("\n=> One address for the whole cluster. Moving the relay here changes the");
  console.log("   hostname, not the address the source sees. Argue it as redundancy only.");
} else if (everything.size <= reporting.length) {
  console.log(`\n=> ${everything.size} addresses across ${reporting.length} reporting projects: a shared NAT,`);
  console.log("   most likely per region. Another project in an existing region adds nothing;");
  console.log("   a project in a NEW region is what adds an address.");
} else {
  // The measured case. Counting addresses per project misreads it: the address
  // turns over per cold isolate, so what matters is calls-to-addresses, and
  // whether the projects draw from one pool or several.
  const perCall = (everything.size / (ROUNDS * reporting.length)).toFixed(2);
  console.log(`\n=> ${everything.size} addresses from ${ROUNDS * reporting.length} calls (${perCall} per call).`);
  console.log("   The address rotates per invocation, not per project. Check the /16 overlap");
  console.log("   above: if the projects share ranges it is one pool, and ONE project already");
  console.log("   gives the full rotation — more accounts buy nothing here.");
}

if (args.has("deno")) {
  const response = await fetch("https://alphytv.alphy.deno.net/health").catch(() => null);
  console.log(`\ncompared against the current relay: alphytv.alphy.deno.net (${response?.status ?? "unreachable"})`);
  console.log("Its own egress address is not observable from outside — that would need the");
  console.log("same probe deployed there, or a look at what a destination logs.");
}
