import { clearAdminSession } from "../_admin-auth.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.end("Method Not Allowed");
    return;
  }
  clearAdminSession(res);
  res.statusCode = 204;
  res.setHeader("Cache-Control", "no-store");
  res.end();
}
