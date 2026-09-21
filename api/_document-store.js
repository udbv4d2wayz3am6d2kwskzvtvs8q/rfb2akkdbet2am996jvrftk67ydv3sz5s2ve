// Small administrative documents only. Public visitors read CDN snapshots;
// they never read this table, and API keys remain in its private ciphertext.
export async function documentRpc(name, args) {
  const base = process.env.ALPHY_STATE_URL;
  const key = process.env.ALPHY_STATE_SERVICE_KEY;
  if (!base || !key) throw new Error("state_store_not_configured");
  const response = await fetch(`${base.replace(/\/$/, "")}/rest/v1/rpc/${name}`, {
    method: "POST", headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(args), signal: AbortSignal.timeout(10000), cache: "no-store",
  });
  if (!response.ok) throw new Error(`state_store:${response.status}`);
  return response.json();
}
export const readDocument = (name) => documentRpc("alphy_document_read", { p_name: name });
export async function writeDocument(name, payload, expectedRevision, revision) {
  const result = await documentRpc("alphy_document_write", {
    p_name: name, p_payload: payload, p_expected: expectedRevision, p_revision: revision,
  });
  if (!result?.written) {
    const error = new Error(`${name}_revision_conflict`);
    error.code = error.message;
    error.document = result?.current;
    throw error;
  }
  return result;
}
