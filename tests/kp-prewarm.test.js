import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrewarmReader } from '../scripts/prewarm-kp.mjs';
const reply = (status, body = {}) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const options = { token: 'test-only', sleep: async () => {}, log: () => {} };

test('a transient state failure retries within the same fill budget', async () => {
  let calls = 0;
  const reader = createPrewarmReader({ ...options, maxFills: 2, fetcher: async (url) => {
    if (url.includes('/storage/')) return reply(404);
    return ++calls === 1 ? reply(503, { error: 'state_unavailable' }) : reply(200, { data: { title: 'Film' } });
  } });
  assert.deepEqual(await reader.get('film', '301'), { title: 'Film' });
  assert.equal(reader.stats.fills, 2); assert.equal(reader.stats.retries, 1);
  assert.equal(await reader.get('film', '302'), null); assert.equal(calls, 2);
});

test('a published response after a timeout avoids another broker attempt', async () => {
  let brokerCalls = 0;
  const reader = createPrewarmReader({ ...options, fetcher: async (url) => {
    if (url.includes('/storage/')) return brokerCalls ? reply(200, { kind: 'film', id: 301, freshUntil: new Date(Date.now()+60000).toISOString(), data: { title: 'Film' } }) : reply(404);
    brokerCalls += 1; throw new Error('timeout');
  } });
  assert.deepEqual(await reader.get('film', '301'), { title: 'Film' });
  assert.equal(brokerCalls, 1);
});

test('persistent failures stop after three attempts instead of being reported as success', async () => {
  const reader = createPrewarmReader({ ...options, fetcher: async (url) => reply(url.includes('/storage/') ? 404 : 503, { error: 'state_unavailable' }) });
  await assert.rejects(reader.get('film', '301'), /failed after 3 attempts/);
  assert.equal(reader.stats.fills, 3);
});

test('quota exhaustion is not retried and an existing lease is deferred', async () => {
  for (const error of ['budget_exhausted', 'keys_refused', 'no_keys']) {
    const reader = createPrewarmReader({ ...options, fetcher: async (url) => reply(url.includes('/storage/') ? 404 : 503, { error }) });
    await assert.rejects(reader.get('film', '301'), /stop prewarming/);
    assert.equal(reader.stats.fills, 1);
  }
  const reader = createPrewarmReader({ ...options, fetcher: async (url) => reply(url.includes('/storage/') ? 404 : 202, { error: 'busy' }) });
  assert.equal(await reader.get('film', '301'), null);
  assert.equal(reader.stats.deferred, 1);
});
