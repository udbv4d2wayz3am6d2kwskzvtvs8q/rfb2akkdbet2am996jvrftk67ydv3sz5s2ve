import { readFile } from "node:fs/promises";

const token = String(process.env.SUPABASE_ACCESS_TOKEN || "").trim();
const projectRef = String(process.env.SUPABASE_PROJECT_REF || "").trim();
if (!/^sbp_[A-Za-z0-9]+$/.test(token)) throw new Error("SUPABASE_ACCESS_TOKEN is missing");
if (!/^[a-z]{20}$/.test(projectRef)) throw new Error("SUPABASE_PROJECT_REF is invalid");

const query = await readFile(new URL("../supabase/functions/letterboxd/schema.sql", import.meta.url), "utf8");
const response = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ query }),
  signal: AbortSignal.timeout(30_000),
});
if (!response.ok) {
  const detail = (await response.text()).replace(/\s+/g, " ").slice(0, 300);
  throw new Error(`Supabase schema ${projectRef}: ${response.status} ${detail}`);
}
console.log(`Letterboxd schema ready: ${projectRef}`);
