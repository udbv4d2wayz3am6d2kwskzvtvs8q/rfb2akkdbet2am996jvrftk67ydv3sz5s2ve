#!/usr/bin/env node
// Integration check in a uniquely named, temporary schema on a TEST project.
// Uses real concurrent transactions. Never modifies the application's tables.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const ref = process.env.SUPABASE_TEST_REF;
const token = process.env.SUPABASE_ACCESS_TOKEN;
if (!/^[a-z]{20}$/.test(ref || "") || !token) throw new Error("SUPABASE_TEST_REF and SUPABASE_ACCESS_TOKEN required");
const schema = `alphy_verify_${randomBytes(6).toString("hex")}`;
async function query(sql) {
  const response = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql }), signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Test SQL HTTP ${response.status}: ${(await response.text()).slice(0, 400)}`);
  return response.json();
}
const checks = [];
const sqlJson = (value) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
await query(`create schema ${schema}`);
try {
  const files = ["supabase/admin-documents.sql", "supabase/functions/kp/schema.sql", "supabase/functions/titles/schema.sql", "supabase/kp-maintenance.sql"];
  const definitions = await Promise.all(files.map(async (file) => (await readFile(file, "utf8"))
    .replaceAll("public.", `${schema}.`).replaceAll("search_path = public", `search_path = ${schema}`)));
  await query(`set search_path = ${schema};\n${definitions.join("\n")}`);
  checks.push("all SQL definitions compile");

  const refreshers = await Promise.all(Array.from({ length: 8 }, () => query(`select ${schema}.kp_key_snapshot_read() as result`)));
  assert.equal(refreshers.filter((r) => r[0].result.refresh).length, 1);
  await query(`select ${schema}.kp_key_snapshot_write(4, '[]'::jsonb)`);
  const [{ snapshot }] = await query(`select ${schema}.kp_key_snapshot_write(3, '[{"id":"test","value":"test"}]'::jsonb) as snapshot`);
  assert.deepEqual(snapshot, { revision: 4, keys: [] });
  const [permissions] = await query(`select has_function_privilege('anon','${schema}.kp_key_snapshot_read()','EXECUTE') as anon,
    has_function_privilege('authenticated','${schema}.kp_key_snapshot_read()','EXECUTE') as authenticated`);
  assert.deepEqual(permissions, { anon: false, authenticated: false });
  checks.push("one shared key refresher; old snapshots cannot restore removed keys; viewer roles have no access");

  const reservations = await Promise.all(Array.from({ length: 20 }, () => query(
    `select ${schema}.kp_reserve_key(array['key-a','key-b'], current_date, 3) as key`)));
  assert.equal(reservations.filter((r) => r[0].key).length, 6);
  assert.deepEqual((await query(`select used from ${schema}.kp_key_day order by key_id`)).map((r) => r.used), [3, 3]);
  checks.push("20 concurrent reservations respect the exact shared quota: 3 + 3");

  await query(`insert into ${schema}.kp_cache(kind,kp_id,status,fresh_until) values ('film',301,'ok',now()+interval '7 days')`);
  const [lease] = await query(`select * from ${schema}.kp_acquire('film',301,'test-worker',60)`);
  assert.equal(lease.acquired, true);
  const [{ completed }] = await query(`select ${schema}.kp_complete_v2('film',301,'test-worker',${lease.version},'ok','test-host',now()+interval '7 days',null,100) as completed`);
  assert.equal(completed, true);
  assert.equal((await query(`select format_version from ${schema}.kp_cache where kind='film' and kp_id=301`))[0].format_version, 2);
  await query(`select ${schema}.kp_prune_state()`);
  assert.equal((await query(`select count(*)::int as n from ${schema}.kp_key_day`))[0].n, 2);
  checks.push("legacy cache state requires v2 fill; completion marks v2; maintenance keeps today's quota");

  const writes = await Promise.all([1, 2].map((value) => query(
    `select ${schema}.alphy_document_write('catalog', '{"value":${value}}', 0, 1) as result`)));
  assert.equal(writes.filter((r) => r[0].result.written).length, 1);
  checks.push("two concurrent catalog writes: one wins, one revision conflict");

  const catalog = [{ id: 1, name: "Example", slug: "example", year: 2026, source_revision: "one" }];
  await query(`select ${schema}.titles_upsert_catalog(${sqlJson(catalog)})`);
  await query(`select ${schema}.titles_fill(${sqlJson([{ id: 1, kp: "301", origin_name: "Original", embed_id: 5 }])})`);
  await query(`select ${schema}.titles_fill(${sqlJson([{ id: 1, kp: "", origin_name: "", embed_id: null }])})`);
  const [kept] = await query(`select kp, origin_name, embed_id from ${schema}.titles where id=1`);
  assert.deepEqual(kept, { kp: "301", origin_name: "Original", embed_id: 5 });
  checks.push("an empty later response preserves known KP, original name and player");

  catalog[0].source_revision = "two";
  await query(`select ${schema}.titles_upsert_catalog(${sqlJson(catalog)})`);
  const next = await query(`select * from ${schema}.titles_pending(10)`);
  assert.ok(next.some((r) => r.id === 1));
  checks.push("a changed source revision requeues a previously complete title");

  await query(`set search_path = ${schema};
    insert into titles(id,name,slug,first_seen_at) values (2,'Recent','recent',now()),(3,'Legacy','legacy',null);
    select titles_fill('[{"id":2,"kp":"","embed_id":null},{"id":3,"kp":"","embed_id":null}]'::jsonb)`);
  const windows = await query(`select id, round(extract(epoch from next_check_at-last_checked_at)/3600)::int as hours
    from ${schema}.titles where id in (2,3) order by id`);
  assert.deepEqual(windows, [{ id: 2, hours: 4 }, { id: 3, hours: 24 }]);
  await query(`set search_path = ${schema}; update ${schema}.titles set next_check_at=now()-interval '1 minute' where id=2`);
  assert.ok((await query(`select * from ${schema}.titles_pending(6)`)).some((r) => r.id === 2));
  checks.push("new incomplete titles retry in four hours and receive urgent slots; legacy backlog stays on daily checks");

  // A large old retry backlog must leave slots for new titles and changes.
  await query(`set search_path = ${schema}; insert into titles(id,name,slug,last_checked_at,next_check_at,first_seen_at)
    select n,'Old '||n,'old-'||n,now()-interval '2 days',now()-interval '1 day',null from generate_series(100,199) n;
    insert into titles(id,name,slug) select n,'New '||n,'new-'||n from generate_series(200,219) n`);
  const batch = await query(`select * from ${schema}.titles_pending(12)`);
  assert.equal(batch.length, 12);
  assert.equal(new Set(batch.map((r) => r.id)).size, 12);
  assert.ok(batch.some((r) => r.id === 1));
  assert.ok(batch.some((r) => r.id >= 200));
  assert.ok(batch.some((r) => r.id >= 100 && r.id < 200));
  checks.push("retry backlog, fresh titles and source changes all receive slots without duplicates");
} finally {
  await query(`drop schema ${schema} cascade`);
}
const evidence = { checkedAt: new Date().toISOString(), testProject: ref, isolatedSchemaRemoved: true, checks };
if (process.env.ALPHY_SQL_EVIDENCE) await writeFile(process.env.ALPHY_SQL_EVIDENCE, JSON.stringify(evidence, null, 2) + "\n");
console.log(JSON.stringify(evidence, null, 2));
