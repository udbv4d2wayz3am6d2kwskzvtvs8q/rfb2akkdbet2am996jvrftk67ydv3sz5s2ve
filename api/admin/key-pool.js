import { requireAdmin } from "../_admin-auth.js";
import {
  ensureKeyPool,
  readKeyPool,
  writeKeyPool,
} from "../_key-pool-store.js";

const DEFAULT_RESOLVER_URL = "https://alphytv.alphy.deno.net";
const MAX_BODY_BYTES = 160 * 1024;

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

function resolverUrl(pathname) {
  const base = String(process.env.ALPHY_RESOLVER_URL || DEFAULT_RESOLVER_URL).replace(/\/+$/, "");
  return `${base}${pathname}`;
}

async function denoControl(pool, { reload = false } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetch(resolverUrl(reload ? "/key-pool/reload" : "/key-pool/status"), {
      method: reload ? "POST" : "GET",
      headers: {
        "Authorization": `Bearer ${pool.runtimeToken}`,
        "Accept": "application/json",
      },
      cache: "no-store",
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = null;
    try { payload = JSON.parse(text); } catch { /* report the HTTP state below */ }
    if (!response.ok || payload?.ok === false) {
      return {
        linked: false,
        status: response.status,
        error: payload?.error || text.slice(0, 160) || `HTTP ${response.status}`,
      };
    }
    return { linked: true, ...payload };
  } catch (error) {
    return {
      linked: false,
      status: 0,
      error: error?.name === "AbortError" ? "Deno timeout" : String(error?.message || error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function setupInfo(pool) {
  const org = String(process.env.DENO_DEPLOY_ORG || "alphy");
  const app = String(process.env.DENO_DEPLOY_APP || "alphytv");
  const suffix = `--secret --org ${org} --app ${app}`;
  return {
    token: pool.runtimeToken,
    addCommand: `deno deploy env add ALPHY_KEY_POOL_TOKEN "${pool.runtimeToken}" ${suffix}`,
    updateCommand: `deno deploy env update-value ALPHY_KEY_POOL_TOKEN "${pool.runtimeToken}" --org ${org} --app ${app}`,
  };
}

async function testProviderKey(provider, key) {
  const value = String(key || "").trim();
  if (!value || !["poiskkino", "unofficial"].includes(provider)) {
    return { ok: false, status: 400, error: "invalid_key_or_provider" };
  }
  const target = provider === "poiskkino"
    ? "https://api.poiskkino.dev/v1.5/token"
    : `https://kinopoiskapiunofficial.tech/api/v1/api_keys/${encodeURIComponent(value)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  const started = Date.now();
  try {
    const response = await fetch(target, {
      headers: { "Accept": "application/json", "X-API-KEY": value },
      cache: "no-store",
      signal: controller.signal,
    });
    const text = await response.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* preserve the status */ }
    const latencyMs = Date.now() - started;
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        latencyMs,
        error: data?.message || data?.error || text.slice(0, 180) || `HTTP ${response.status}`,
      };
    }
    const positive = (value) => {
      const number = Number(value);
      return Number.isFinite(number) && number > 0 ? number : null;
    };
    const quota = provider === "poiskkino"
      ? {
          dailyLimit: positive(data?.requestsLimit),
          dailyUsed: Number(data?.requestsUsed) || 0,
          dailyRemaining: Number(data?.requestsRemaining) || 0,
          resetAt: data?.resetAt || null,
          resetTtlSeconds: Number(data?.ttl) || null,
        }
      : {
          dailyLimit: positive(data?.dailyQuota?.value),
          dailyUsed: Number(data?.dailyQuota?.used) || 0,
          dailyRemaining: Math.max(0, Number(data?.dailyQuota?.value || 0) - Number(data?.dailyQuota?.used || 0)),
          totalLimit: positive(data?.totalQuota?.value),
          totalUsed: Number(data?.totalQuota?.used) || 0,
          accountType: data?.accountType || null,
        };
    return { ok: true, status: response.status, latencyMs, quota };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      latencyMs: Date.now() - started,
      error: error?.name === "AbortError" ? "timeout" : String(error?.message || error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function send(res, body, status = 200) {
  res.statusCode = status;
  res.setHeader("Cache-Control", "no-store, private");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

export default async function handler(req, res) {
  if (!requireAdmin(req, res)) return;
  if (!["GET", "PUT", "POST"].includes(req.method || "")) {
    res.setHeader("Allow", "GET, PUT, POST");
    send(res, { ok: false, error: "method_not_allowed" }, 405);
    return;
  }

  try {
    if (req.method === "GET") {
      let pool = await ensureKeyPool();
      const deno = await denoControl(pool);
      // The first successful Deno link imports legacy env keys while this
      // request is in flight. If that advanced the registry revision, return
      // the freshly imported pool instead of making the admin reopen the dialog.
      if (Number(deno?.revision) > Number(pool.revision)) {
        pool = (await readKeyPool()).pool;
      }
      send(res, { ok: true, pool, deno, setup: setupInfo(pool) });
      return;
    }

    const payload = await readBody(req);
    if (req.method === "POST") {
      if (payload?.action === "test") {
        send(res, {
          ok: true,
          result: await testProviderKey(String(payload.provider || ""), payload.value),
        });
        return;
      }
      if (payload?.action === "reload") {
        const { pool } = await readKeyPool();
        send(res, { ok: true, deno: await denoControl(pool, { reload: true }) });
        return;
      }
      send(res, { ok: false, error: "unknown_action" }, 400);
      return;
    }

    const expectedRevision = Number(payload?.baseRevision);
    const result = await writeKeyPool(
      payload?.pool,
      Number.isInteger(expectedRevision) ? expectedRevision : null,
    );
    const deno = await denoControl(result.pool, { reload: true });
    send(res, { ok: true, ...result, deno, setup: setupInfo(result.pool) });
  } catch (error) {
    if (error?.code === "key_pool_revision_conflict") {
      send(res, { ok: false, error: error.code, pool: error.current }, 409);
      return;
    }
    if (error?.code === "key_pool_too_large" || error?.message === "request_too_large") {
      send(res, { ok: false, error: error.code || error.message }, 413);
      return;
    }
    console.error("[key-pool]", error?.code || error?.message || String(error));
    send(res, { ok: false, error: "key_pool_failed" }, 500);
  }
}
