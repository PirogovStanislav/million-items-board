const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createApp } = require('../src/app');

async function setup(t, options = {}) {
  const runtime = createApp(options);
  const server = runtime.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await runtime.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (url, payload, method = 'GET', headers = {}) => {
    const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: payload === undefined ? undefined : JSON.stringify(payload) });
    return { status: response.status, body: await response.json() };
  };
  const wait = async (id) => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const result = await request(`/api/operations/${id}`);
      if (result.body.status !== 'queued') return result.body;
    }
    throw new Error('Operation did not complete');
  };
  return { ...runtime, base, request, wait };
}

test('favicon is linked from HTML and the legacy URL redirects to the SVG', async (t) => {
  const { base } = await setup(t, { initialCount: 20 });
  const html = await fetch(base);
  assert.equal(html.status, 200);
  assert.match(await html.text(), /rel="icon"[^>]*href="\/favicon\.svg"/);
  const legacy = await fetch(`${base}/favicon.ico`, { redirect: 'manual' });
  assert.equal(legacy.status, 302);
  assert.equal(legacy.headers.get('location'), '/favicon.svg');
  const icon = await fetch(`${base}/favicon.ico`);
  assert.equal(icon.status, 200);
  assert.match(icon.headers.get('content-type'), /^image\/svg\+xml/);
  assert.match(await icon.text(), /^<svg\s/);
});

test('production cadence: data reads every second and additions every ten seconds', async (t) => {
  const { batcher, request, wait } = await setup(t);
  const start = batcher.lastAddAt;
  const add = await request('/api/items', { id: 'cadence-test' }, 'POST');
  assert.equal(add.status, 202);
  assert.equal(add.body.batchIn, 10_000);
  const first = await request('/api/items?side=available');
  assert.equal(first.body.items.length, 20);
  assert.equal(first.body.total, 1_000_000);
  assert.ok(Date.now() - start >= 900, 'first read must wait for the timer');
  const completed = await wait(add.body.operationId);
  assert.equal(completed.status, 'applied');
  assert.ok(completed.completedAt - start >= 10_000, 'add cannot commit before 10-second tick');
  const match = await request('/api/items?q=cadence-test');
  assert.deepEqual(match.body.items, ['cadence-test']);
});

test('HTTP concurrent requests, validation, filters and persistence across separate clients', async (t) => {
  const { request, wait, batcher } = await setup(t, { intervalMs: 50, addIntervalMs: 500 });
  const writes = await Promise.all(Array.from({ length: 100 }, () => request('/api/items', { id: 'custom-α' }, 'POST')));
  assert.ok(writes.every((result) => result.status === 202));
  assert.equal(new Set(writes.map((result) => result.body.operationId)).size, 1);
  assert.equal((await wait(writes[0].body.operationId)).status, 'applied');
  assert.equal((await request('/api/items', { id: 'custom-α' }, 'POST')).status, 409);
  for (const id of ['11', '2', '12', '3', '13']) {
    const result = await request('/api/selected', { id }, 'POST');
    assert.equal((await wait(result.body.operationId)).status, 'applied');
  }
  const move = await request('/api/selected/move', { id: '13', targetId: '11', position: 'before', query: '1' }, 'POST');
  await wait(move.body.operationId);
  const newClient = await request('/api/items?side=selected');
  assert.deepEqual(newClient.body.items, ['13', '2', '11', '3', '12']);
  assert.deepEqual((await request('/api/items?side=selected&q=1')).body.items, ['13', '11', '12']);
  assert.equal((await request('/api/items?q=custom-%CE%B1')).body.items[0], 'custom-α');
  const before = batcher.stats.readsDeduplicated;
  await Promise.all(Array.from({ length: 100 }, () => request('/api/items?q=777')));
  assert.ok(batcher.stats.readsDeduplicated > before);
  assert.equal((await request('/api/items?offset=-1')).status, 400);
  assert.equal((await request('/api/items?side=invalid')).status, 400);
  assert.equal((await request('/api/items?limit=100')).status, 400);
  assert.equal((await request('/api/items', { id: {} }, 'POST')).status, 400);
  assert.equal((await request('/api/unknown')).status, 404);
  const invalid = await request('/api/selected', { id: 'not-found' }, 'POST');
  assert.equal((await wait(invalid.body.operationId)).status, 'rejected');
});
