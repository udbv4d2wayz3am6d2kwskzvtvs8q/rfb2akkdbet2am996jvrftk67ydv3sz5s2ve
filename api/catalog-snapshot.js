import { readCatalog } from "./_catalog-store.js";
// Publisher endpoint. Visitors normally read the baked jsDelivr snapshot.
export default async function handler(req, res) {
  if (req.method !== "GET") { res.statusCode = 405; res.end(); return; }
  try {
    const { catalog } = await readCatalog();
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
    res.end(JSON.stringify(catalog));
  } catch {
    res.statusCode = 503; res.setHeader("Cache-Control", "no-store"); res.end('{"error":"catalog_unavailable"}');
  }
}
