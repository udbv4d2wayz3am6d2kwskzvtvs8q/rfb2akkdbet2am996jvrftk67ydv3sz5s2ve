
function send(res, body, status = 200) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Access-Control-Allow-Origin", "*");
  // Only the empty compatibility envelope is public.
  res.setHeader("Cache-Control", "public, max-age=300, s-maxage=300, stale-while-revalidate=3600");
  res.end(JSON.stringify(body));
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");
    send(res, { ok: false, error: "method_not_allowed" }, 405);
    return;
  }
  // Compatibility endpoint for old tabs. New clients never request it; quota
  // is owned by the shared broker, so fresh copies of keys are no longer public.
  send(res, { ok: true, pool: { schema: 1, revision: 0, updatedAt: null, keys: [] } });
}
