const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../src/store');
const { Batcher } = require('../src/batcher');

function setup(t, options) {
  const store = new Store(100);
  const batcher = new Batcher(store, { autoStart: false, ...options });
  t.after(() => batcher.close());
  return { store, batcher };
}

test('reads wait for flush and 1000 identical requests share one computation', async (t) => {
  const { store, batcher } = setup(t);
  let computations = 0;
  const reads = Array.from({ length: 1000 }, () => batcher.read('state', () => { computations += 1; return store.state(); }));
  assert.equal(computations, 0);
  assert.equal(batcher.reads.size, 1);
  assert.equal(reads[0], reads[999]);
  await batcher.flush();
  const values = await Promise.all(reads);
  assert.equal(computations, 1);
  assert.equal(values[0].availableCount, 100);
  assert.equal(batcher.stats.readsDeduplicated, 999);
});

test('1000 simultaneous add requests reserve one ID, apply only at 10 seconds and reject later duplicates', async (t) => {
  const { store, batcher } = setup(t);
  const start = batcher.lastAddAt;
  const writes = Array.from({ length: 1000 }, () => batcher.enqueue('add', { id: 'new' }));
  assert.equal(new Set(writes.map((operation) => operation.id)).size, 1);
  await batcher.flush(start + 9999);
  assert.equal(store.exists('new'), false);
  await batcher.flush(start + 10_000);
  assert.equal(store.custom.size, 1);
  assert.equal(writes[0].status, 'applied');
  assert.throws(() => batcher.enqueue('add', { id: 'new' }), { status: 409 });
});

test('FIFO select/unselect/select is not collapsed into the wrong operation', async (t) => {
  const { store, batcher } = setup(t);
  const first = batcher.enqueue('select', { id: '1' });
  const duplicate = batcher.enqueue('select', { id: '1' });
  const remove = batcher.enqueue('unselect', { id: '1' });
  const last = batcher.enqueue('select', { id: '1' });
  assert.equal(first.id, duplicate.id);
  assert.notEqual(first.id, last.id);
  assert.equal(store.selected.length, 0);
  await batcher.flush();
  assert.deepEqual(store.selected, ['1']);
  assert.equal(store.revision, 3);
  assert.equal(remove.status, 'applied');
  assert.equal(last.status, 'applied');
});

test('select, move, unselect share FIFO, and rejected operations do not stop the batch', async (t) => {
  const { store, batcher } = setup(t);
  batcher.enqueue('select', { id: '1' });
  batcher.enqueue('select', { id: '2' });
  const move = batcher.enqueue('move', { id: '2', targetId: '1', position: 'before', query: '' });
  batcher.enqueue('unselect', { id: '1' });
  const invalid = batcher.enqueue('select', { id: 'missing' });
  batcher.enqueue('select', { id: '3' });
  await batcher.flush();
  assert.deepEqual(store.selected, ['2', '3']);
  assert.equal(move.status, 'applied');
  assert.equal(invalid.status, 'rejected');
});

test('interleaved duplicate selections share reservations without changing append order', async (t) => {
  const { store, batcher } = setup(t);
  const first = batcher.enqueue('select', { id: '1' });
  batcher.enqueue('select', { id: '2' });
  assert.equal(batcher.enqueue('select', { id: '1' }).id, first.id);
  batcher.enqueue('unselect', { id: '1' });
  const last = batcher.enqueue('select', { id: '1' });
  assert.notEqual(first.id, last.id);
  await batcher.flush();
  assert.deepEqual(store.selected, ['2', '1']);
});

test('idempotency replay survives completion, conflicts fail, records expire', async (t) => {
  const { store, batcher } = setup(t, { retentionMs: 100 });
  const first = batcher.enqueue('select', { id: '1' }, 'request-1');
  await batcher.flush();
  const replay = batcher.enqueue('select', { id: '1' }, 'request-1');
  assert.equal(replay.id, first.id);
  assert.equal(replay.status, 'applied');
  assert.throws(() => batcher.enqueue('select', { id: '2' }, 'request-1'), { status: 409 });
  assert.equal(store.revision, 1);
  batcher.prune(first.completedAt + 101);
  assert.equal(batcher.operations.size, 0);
  assert.equal(batcher.idempotency.size, 0);
});

test('bounded queues refuse overload while duplicates can still join', async (t) => {
  const { batcher } = setup(t, { maxQueue: 1, maxReads: 1 });
  const first = batcher.enqueue('select', { id: '1' });
  assert.equal(batcher.enqueue('select', { id: '1' }).id, first.id);
  assert.throws(() => batcher.enqueue('select', { id: '2' }), { status: 503 });
  const read = batcher.read('state', () => ({}));
  assert.equal(batcher.read('state', () => ({})), read);
  await assert.rejects(batcher.read('other', () => ({})), { status: 503 });
  await batcher.flush();
  await read;
});

test('writes wait during async reads and the whole batch observes one revision', async (t) => {
  const { store, batcher } = setup(t);
  let finish;
  const gate = new Promise((resolve) => { finish = resolve; });
  const read = batcher.read('slow', async () => { await gate; return store.revision; });
  const flush = batcher.flush();
  batcher.enqueue('select', { id: '1' });
  await batcher.flush();
  assert.equal(store.revision, 0);
  finish();
  await flush;
  assert.equal(await read, 0);
  await batcher.flush();
  assert.equal(store.revision, 1);
});
