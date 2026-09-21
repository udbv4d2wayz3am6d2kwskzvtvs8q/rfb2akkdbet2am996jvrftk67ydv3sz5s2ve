type Snapshot = { revision: number; keys: Array<{ id: string; value: string }>; refresh?: boolean };

// A private database snapshot lets a cold broker fill titles even while the
// administrative Vercel endpoint is slow. SQL elects one refresher; revisions
// prevent an older reply from restoring keys an admin has since removed.
export function createKeyLoader({ rpc, loadManaged, background, now = Date.now }: {
  rpc: (name: string, args: Record<string, unknown>) => Promise<any>;
  loadManaged: () => Promise<Snapshot>;
  background: (promise: Promise<unknown>) => void;
  now?: () => number;
}) {
  let current: Snapshot | null = null;
  let nextRead = 0;
  let pending: Promise<Snapshot["keys"]> | null = null;
  const accept = (snapshot: Snapshot) => {
    if (Number.isInteger(snapshot?.revision) && snapshot.revision >= 0 && Array.isArray(snapshot.keys) &&
        (!current || snapshot.revision >= current.revision)) current = snapshot;
  };
  const refresh = async () => {
    const fresh = await loadManaged();
    const saved = await rpc("kp_key_snapshot_write", { p_revision: fresh.revision, p_keys: fresh.keys });
    accept(saved);
    if (!current) throw new Error("managed key pool unavailable");
    nextRead = now() + 5 * 60e3;
    return current.keys;
  };
  return async () => {
    if (current && now() < nextRead) return current.keys;
    if (pending) return pending;
    pending = (async () => {
      const snapshot = await rpc("kp_key_snapshot_read", {});
      accept(snapshot);
      if (!current) {
        if (!snapshot?.refresh) throw new Error("managed key pool refresh in progress");
        return refresh();
      }
      nextRead = now() + 5 * 60e3;
      if (snapshot.refresh) background(refresh().catch(() => { nextRead = now() + 30000; }));
      return current.keys;
    })().catch((error) => {
      nextRead = now() + 30000;
      if (current) return current.keys;
      throw error;
    }).finally(() => { pending = null; });
    return pending;
  };
}
