import test from "node:test";
import assert from "node:assert/strict";
import {
  clearAdminSession,
  isAdmin,
  isBasicAdmin,
  setAdminSession,
} from "../api/_admin-auth.js";
import loginHandler from "../api/admin/login.js";

const previousUser = process.env.ALPHY_ADMIN_USER;
const previousPassword = process.env.ALPHY_ADMIN_PASSWORD;
process.env.ALPHY_ADMIN_USER = "editor";
process.env.ALPHY_ADMIN_PASSWORD = "correct horse";

test.after(() => {
  if (previousUser == null) delete process.env.ALPHY_ADMIN_USER;
  else process.env.ALPHY_ADMIN_USER = previousUser;
  if (previousPassword == null) delete process.env.ALPHY_ADMIN_PASSWORD;
  else process.env.ALPHY_ADMIN_PASSWORD = previousPassword;
});

function responseStub() {
  const headers = new Map();
  return {
    statusCode: 200,
    headers,
    body: null,
    setHeader(name, value) { headers.set(String(name).toLowerCase(), value); },
    end(value = "") { this.body = value; },
  };
}

function basic(user = "editor", password = "correct horse") {
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

test("native Basic credentials are accepted only by the login gate", () => {
  const req = { headers: { authorization: basic() } };
  assert.equal(isBasicAdmin(req), true);
  assert.equal(isAdmin(req), false);
  assert.equal(isBasicAdmin({ headers: { authorization: basic("editor", "wrong") } }), false);
});

test("signed HttpOnly session authorizes catalog requests", () => {
  const res = responseStub();
  setAdminSession(res);
  const setCookie = res.headers.get("set-cookie");
  assert.match(setCookie, /alphy_admin_session=/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  const cookie = setCookie.split(";", 1)[0];
  assert.equal(isAdmin({ headers: { cookie } }), true);
  assert.equal(isAdmin({ headers: { cookie: `${cookie}x` } }), false);

  clearAdminSession(res);
  assert.match(res.headers.get("set-cookie"), /Max-Age=0/);
});

test("login endpoint sets the session and sanitizes its return path", async () => {
  const req = {
    method: "GET",
    headers: { authorization: basic() },
    query: { return: "/search/test?debug=1#section" },
  };
  const res = responseStub();
  await loginHandler(req, res);
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.get("location"), "/search/test?debug=1&admin=1#section");
  assert.match(res.headers.get("set-cookie"), /HttpOnly/);

  const unsafe = responseStub();
  await loginHandler({ ...req, query: { return: "//evil.example/" } }, unsafe);
  assert.equal(unsafe.headers.get("location"), "/?admin=1");
});
