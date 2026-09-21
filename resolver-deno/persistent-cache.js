// Durable fallback when Deploy has no attached KV. Contains only stable player
// identity (no signed media URLs), written once per resolved title.
export function createPersistentCache({ url, key, fetcher = fetch } = {}) {
  return {
    async get(id) {
      if (!url || !key || !/^\d+$/.test(String(id))) return null;
      try {
        const response = await fetcher(`${url}/storage/v1/object/provider-cache/zona/${id}.json`, {
          headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(4000),
        });
        if (!response.ok) return null;
        const value = await response.json();
        return value?.storedAt && Date.now() - value.storedAt < 30 * 86400e3 ? value : null;
      } catch { return null; }
    },
    async set(id, value) {
      if (!url || !key || !/^\d+$/.test(String(id))) return;
      await fetcher(`${url}/storage/v1/object/provider-cache/zona/${id}.json`, {
        method: "POST", headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", "x-upsert": "true" },
        body: JSON.stringify(value), signal: AbortSignal.timeout(5000),
      }).catch(() => {});
    },
  };
}
