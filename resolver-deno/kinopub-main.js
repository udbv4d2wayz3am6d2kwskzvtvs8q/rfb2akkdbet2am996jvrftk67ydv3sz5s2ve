import { createKinoPubResolver } from "./kinopub-core.js";

const envKeys = [
  "KINOPUB_API_BASE",
  "KINOPUB_OAUTH_URL",
  "KINOPUB_CLIENT_ID",
  "KINOPUB_CLIENT_SECRET",
  "KINOPUB_ACCESS_TOKEN",
  "KINOPUB_REFRESH_TOKEN",
  "KINOPUB_ACCESS_EXPIRES_AT",
  "KINOPUB_RESOLVER_KEY",
  "KINOPUB_ALLOWED_ORIGINS",
  "PORT",
];
const env = Object.fromEntries(envKeys.map((key) => [key, Deno.env.get(key)]));

let kv = null;
try {
  kv = await Deno.openKv();
} catch {
  // A deployment without KV is sufficient for a short egress test, but its
  // rotated refresh token cannot survive an isolate restart. /health exposes
  // this explicitly as persistentTokenStore=false.
}

const port = Number(env.PORT || "8000");
Deno.serve({ port }, createKinoPubResolver({ env, kv }));
