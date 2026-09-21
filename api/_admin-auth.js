import crypto from "node:crypto";

const SESSION_COOKIE = "alphy_admin_session";
const SESSION_TTL_SECONDS = 8 * 60 * 60;

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""), "utf8");
  const b = Buffer.from(String(right || ""), "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function expectedCredentials() {
  return {
    user: String(process.env.ALPHY_ADMIN_USER || ""),
    password: String(process.env.ALPHY_ADMIN_PASSWORD || ""),
  };
}

function suppliedBasicCredentials(req) {
  const header = String(req.headers.authorization || "");
  if (!/^basic\s+/i.test(header)) return { user: "", password: "" };
  try {
    const decoded = Buffer.from(header.replace(/^basic\s+/i, ""), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) return { user: "", password: "" };
    return {
      user: decoded.slice(0, separator),
      password: decoded.slice(separator + 1),
    };
  } catch {
    return { user: "", password: "" };
  }
}

function suppliedLegacyCredentials(req) {
  return {
    user: String(req.headers["x-admin-user"] || ""),
    password: String(req.headers["x-admin-pass"] || ""),
  };
}

function credentialsMatch(supplied) {
  const expected = expectedCredentials();
  if (!expected.user || !expected.password) return false;
  return safeEqual(supplied.user, expected.user) && safeEqual(supplied.password, expected.password);
}

function sessionSignature(expires) {
  const expected = expectedCredentials();
  if (!expected.user || !expected.password) return "";
  const key = crypto.createHash("sha256")
    .update(`alphy-admin\0${expected.user}\0${expected.password}`)
    .digest();
  return crypto.createHmac("sha256", key)
    .update(`${SESSION_COOKIE}\0${expires}`)
    .digest("base64url");
}

function cookieValue(req, name) {
  const raw = String(req.headers.cookie || "");
  for (const part of raw.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return "";
}

function hasValidSession(req) {
  const token = cookieValue(req, SESSION_COOKIE);
  const separator = token.indexOf(".");
  if (separator < 1) return false;
  const expires = Number(token.slice(0, separator));
  const signature = token.slice(separator + 1);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(expires) || expires <= now || expires > now + SESSION_TTL_SECONDS + 60) return false;
  return safeEqual(signature, sessionSignature(expires));
}

export function isBasicAdmin(req) {
  return credentialsMatch(suppliedBasicCredentials(req));
}

export function isAdmin(req) {
  return hasValidSession(req) || credentialsMatch(suppliedLegacyCredentials(req));
}

export function setAdminSession(res) {
  const expires = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const token = `${expires}.${sessionSignature(expires)}`;
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${token}; Max-Age=${SESSION_TTL_SECONDS}; Path=/api/admin; HttpOnly; Secure; SameSite=Strict`,
  );
}

export function clearAdminSession(res) {
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=; Max-Age=0; Path=/api/admin; HttpOnly; Secure; SameSite=Strict`,
  );
}

function reject(res, { browserPrompt = false } = {}) {
  res.statusCode = 401;
  if (browserPrompt) res.setHeader("WWW-Authenticate", 'Basic realm="alphy admin", charset="UTF-8"');
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ ok: false, error: "admin_auth_required" }));
  return false;
}

export function requireBasicAdmin(req, res) {
  if (isBasicAdmin(req)) return true;
  return reject(res, { browserPrompt: true });
}

export function requireAdmin(req, res) {
  if (isAdmin(req)) return true;
  return reject(res);
}
