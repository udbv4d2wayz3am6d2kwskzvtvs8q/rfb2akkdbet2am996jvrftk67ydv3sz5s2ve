// Diagnostic: what address does this project use when it calls out?
//
// The question it answers: the HDRezka resolver runs on one Deno app, so the
// source sees one IP for every viewer we have. Spreading that across the
// Supabase projects we already run only helps if those projects actually egress
// from different addresses — and Edge Functions share a per-region NAT, so
// several projects in one region are likely to look identical. Guessing is
// cheap and wrong; this measures it.
//
// Deploy (per project, no JWT so a plain curl can read it):
//   supabase functions deploy egress --project-ref <ref> --no-verify-jwt
// then: node scripts/measure-egress.mjs
//
// It takes no input and cannot be pointed at anything, so it is not a proxy. It
// does make two outbound calls per invocation, though, so delete it once the
// measurement is done rather than leaving a free invocation sink on five
// projects:  supabase functions delete egress --project-ref <ref>

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

// Two independent echoes, because a NAT can be per-destination: one answer
// looks conclusive and isn't.
const ECHOES = [
  ["ipify", "https://api.ipify.org"],
  ["icanhazip", "https://icanhazip.com"],
];

// Stable for the life of this isolate. Without it, N identical answers cannot be
// told apart from N calls that all landed on the same warm instance — which is
// the difference between "one IP" and "we only ever saw one".
const ISOLATE = crypto.randomUUID().slice(0, 8);
const BOOTED = Date.now();

async function echo(url: string): Promise<string> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(6000),
      headers: { "User-Agent": "curl/8" },
    });
    if (!response.ok) return `http ${response.status}`;
    return (await response.text()).trim().slice(0, 64);
  } catch (error) {
    return `error: ${String((error as Error)?.message || error).slice(0, 60)}`;
  }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const pairs = await Promise.all(ECHOES.map(async ([name, url]) => [name, await echo(url)]));
  return new Response(JSON.stringify({
    ref: Deno.env.get("SUPABASE_URL")?.match(/https:\/\/([a-z0-9]+)\./)?.[1] || "",
    region: Deno.env.get("SB_REGION") || Deno.env.get("DENO_REGION") || "",
    isolate: ISOLATE,
    isolateAgeMs: Date.now() - BOOTED,
    ip: Object.fromEntries(pairs),
  }, null, 1), { headers: { ...CORS, "Content-Type": "application/json" } });
});
