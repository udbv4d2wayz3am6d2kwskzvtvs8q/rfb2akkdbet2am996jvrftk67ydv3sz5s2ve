import { isAdmin, requireBasicAdmin, setAdminSession } from "../_admin-auth.js";

function safeReturnPath(value) {
  const candidate = String(value || "/");
  const raw = candidate.startsWith("/") && !candidate.startsWith("//") ? candidate : "/";
  try {
    const url = new URL(raw, "https://alphy.invalid");
    if (url.origin !== "https://alphy.invalid") return "/?admin=1";
    url.searchParams.set("admin", "1");
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/?admin=1";
  }
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET");
    res.end("Method Not Allowed");
    return;
  }
  if (!isAdmin(req) && !requireBasicAdmin(req, res)) return;
  setAdminSession(res);
  res.statusCode = 302;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Location", safeReturnPath(req.query?.return));
  res.end();
}
