import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { makeSandbox, sleep } from './helpers/app-sandbox.js';
async function boot() { const ctx=makeSandbox(); ctx.sandbox.PointerEvent=class {}; ctx.run(); await sleep(80); return ctx.sandbox.window.alphyBridge._test; }

test('a fast primary never spends the backup request', async () => {
  const {hedgedRequest}=await boot(); let backups=0;
  assert.equal(await hedgedRequest(async()=> 'direct', async()=>{backups++;return 'relay';},20),'direct');
  await sleep(30); assert.equal(backups,0);
});
test('a hanging primary cannot delay the working relay and is cancelled', async () => {
  const {hedgedRequest}=await boot(); let aborted=false;
  const primary=signal=>new Promise((_,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(new Error('cancelled'));}));
  assert.equal(await hedgedRequest(primary,async()=> 'relay',10),'relay'); assert.equal(aborted,true);
});
test('a primary failure starts backup immediately; two failures remain an error', async () => {
  const {hedgedRequest}=await boot();
  const fail=async()=>{throw new Error('unavailable');};
  const start=Date.now(); assert.equal(await hedgedRequest(fail,async()=> 'relay',2000),'relay'); assert.ok(Date.now()-start<1000);
  await assert.rejects(hedgedRequest(fail,fail,10),/unavailable/);
});
test('touch suggestion activates before a delayed synthesized click, exactly once', async () => {
  const {bindSuggestActivation}=await boot(); const handlers={}; let opened=0;
  bindSuggestActivation({addEventListener:(name,fn)=>{handlers[name]=fn;}},()=>opened++);
  const e={pointerId:1,isPrimary:true,button:0,clientX:10,clientY:10,preventDefault(){}};
  handlers.pointerdown(e); assert.equal(opened,0); handlers.pointerup(e); assert.equal(opened,1);
  handlers.click({...e,detail:1}); assert.equal(opened,1);
});
test('scrolling a suggestion does not open it; keyboard activation still works', async () => {
  const {bindSuggestActivation}=await boot(); const handlers={}; let opened=0;
  bindSuggestActivation({addEventListener:(name,fn)=>{handlers[name]=fn;}},()=>opened++);
  const e={pointerId:1,isPrimary:true,button:0,clientX:10,clientY:10,preventDefault(){}};
  handlers.pointerdown(e); handlers.pointerup({...e,clientY:60}); handlers.click({...e,detail:1}); assert.equal(opened,0);
  handlers.click({...e,detail:0}); assert.equal(opened,1);
});

test('a failed first media sandbox is recreated for the next attempt', async () => {
  const ctx=makeSandbox(); const timers=[]; const original=ctx.sandbox.setTimeout;
  ctx.sandbox.setTimeout=(fn,ms,...args)=>ms===8000?(timers.push(fn),-1):original(fn,ms,...args);
  ctx.run(); await sleep(80);
  const get=ctx.sandbox.window.alphyBridge._test.liftwMediaBroker;
  const first=get(); assert.equal(get(),first);
  timers.shift()(); await assert.rejects(first.ready,/timeout/);
  const second=get(); assert.notEqual(second,first);
  timers.shift()(); await assert.rejects(second.ready,/timeout/);
});

// The player page is minted for whoever fetches it (hi/hu in its media URLs),
// so a relay's copy plays nothing in the browser: measured, the browser's copy
// served the init segment 200 and the relay's copy 410. These run the real
// functions from app.js with their network stubbed.
async function extract(name, deps) {
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8');
  const start = source.indexOf(`  async function ${name}(`);
  const end = source.indexOf('\n  }\n', start) + 4;
  return new Function(...Object.keys(deps), `${source.slice(start, end)}\nreturn ${name};`)(...Object.values(deps));
}
const RELAY = 'https://cuyofxgofmhdugauoqzt.supabase.co/functions/v1/liftw';
const SIGNED = 'https://lift3.ws/embed/movie/1?t2=x';
const BARE = 'https://lift3.ws/embed/movie/1';
const PAGE = '<script>makePlayer({})</script>';
function embedDeps(direct) {
  const calls = [];
  return { calls, deps: {
    fetchThirdPartyText: async (url) => { calls.push(url); return direct(url); },
    liftwRequest: (operation) => operation(new AbortController().signal),
    fetch: async (url) => { calls.push(url); return { ok: true, text: async () => PAGE }; },
    log: () => {},
    LIFTW_ENDPOINTS: [RELAY],
  } };
}

test('a slow direct player page is waited for, never raced by the relay', async () => {
  const { calls, deps } = embedDeps(async () => { await sleep(40); return PAGE; });
  const fetchLiftwEmbed = await extract('fetchLiftwEmbed', deps);
  const result = await fetchLiftwEmbed([SIGNED, BARE, `${RELAY}?mode=embed&id=1`]);
  assert.equal(result.viaRelay, false);
  assert.deepEqual(calls, [SIGNED], 'the relay is not asked while the direct page is on its way');
});

test('a direct timeout skips the same-host bare path; the relay copy is flagged', async () => {
  const { calls, deps } = embedDeps(async () => { throw new Error('Sandbox fetch timeout for x'); });
  const fetchLiftwEmbed = await extract('fetchLiftwEmbed', deps);
  const result = await fetchLiftwEmbed([SIGNED, BARE, `${RELAY}?mode=embed&id=1`]);
  assert.equal(result.viaRelay, true, 'its media URLs belong to the relay');
  assert.deepEqual(calls, [SIGNED, `${RELAY}?mode=embed&id=1`]);
});

test('a direct refusal still tries the bare path before the relay', async () => {
  const { calls, deps } = embedDeps(async (url) => { if (url === SIGNED) throw new Error('403'); return PAGE; });
  const fetchLiftwEmbed = await extract('fetchLiftwEmbed', deps);
  assert.equal((await fetchLiftwEmbed([SIGNED, BARE, `${RELAY}?mode=embed&id=1`])).viaRelay, false);
  assert.deepEqual(calls, [SIGNED, BARE]);
});

test('a relay copy of the player page is never cached', async () => {
  const cached = [];
  const deps = {
    positiveInt: (value) => Number(value) || 0,
    localStorage: { removeItem() {} },
    CACHE_PREFIX: 'alphy.cache.', LIFTW_TITLE_CACHE_NS: 'liftwtitle.v2', TTL: { liftwtitle: 1 },
    cacheGet: () => null, cacheSet: (ns, key) => cached.push(key),
    liftwTitleInflight: new Map(),
    fetchLiftwTitle: async (key) => ({ id: key, sources: { dash: 'x' }, viaRelay: key === '2' }),
  };
  const resolveLiftwTitle = await extract('resolveLiftwTitle', deps);
  await resolveLiftwTitle(1);
  await resolveLiftwTitle(2);
  assert.deepEqual(cached, ['1']);
});
