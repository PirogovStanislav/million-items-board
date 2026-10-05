const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../src/store');

test('million IDs: first, deep, final and empty pages', async (t) => {
  const store = new Store();
  t.after(() => store.close());
  const first = await store.page('available', '', 0);
  assert.deepEqual(first.items, Array.from({ length: 20 }, (_, index) => String(index + 1)));
  assert.equal(first.total, 1_000_000);
  const final = await store.page('available', '', 999980);
  assert.equal(final.items[0], '999981');
  assert.equal(final.items.at(-1), '1000000');
  assert.equal(final.hasMore, false);
  assert.deepEqual((await store.page('available', '', 1_000_000)).items, []);
});

test('pagination matches a naive reference after selection and arbitrary additions', async (t) => {
  const store = new Store(250);
  t.after(() => store.close());
  for (let id = 1; id <= 250; id += 3) store.select(String(id), true);
  for (const id of ['custom-1', 'custom-22', '001', '-5', '<script>', 'новый']) store.add(id);
  store.select('custom-22', true);
  store.select('22', false);
  const all = [...Array.from({ length: 250 }, (_, index) => String(index + 1)), ...store.custom];
  for (const query of ['', '1', '2', '99', 'custom', 'нет', '<script>']) {
    const expected = all.filter((id) => id.includes(query) && !store.selectedSet.has(id));
    for (let offset = 0; offset <= expected.length + 20; offset += 20) {
      const page = await store.page('available', query, offset);
      assert.deepEqual(page.items, expected.slice(offset, offset + 20), `${query}, ${offset}`);
      assert.equal(page.total, expected.length);
      assert.equal(page.hasMore, offset + page.items.length < expected.length);
    }
  }
  assert.throws(() => store.add('1'), { status: 409 });
  assert.throws(() => store.add('custom-1'), { status: 409 });
});

test('filtered moves preserve hidden slots in both directions and with page boundaries', async (t) => {
  const store = new Store();
  t.after(() => store.close());
  for (const id of ['11', '2', '12', '3', '13', '4']) store.select(id, true);
  store.move({ id: '13', targetId: '11', position: 'before', query: '1' });
  assert.deepEqual(store.selected, ['13', '2', '11', '3', '12', '4']);
  store.move({ id: '13', targetId: '12', position: 'after', query: '1' });
  assert.deepEqual(store.selected, ['11', '2', '12', '3', '13', '4']);
  assert.throws(() => store.move({ id: '2', targetId: '11', position: 'before', query: '1' }), { status: 400 });
  for (let id = 101; id <= 140; id += 1) store.select(String(id), true);
  store.move({ id: '140', targetId: '101', position: 'before', query: '1' });
  const first = await store.page('selected', '1', 0);
  const second = await store.page('selected', '1', 20);
  assert.equal(first.items.length, 20);
  assert.equal(second.items.length, 20);
  assert.equal(first.items[3], '140');
  assert.equal(new Set([...first.items, ...second.items]).size, 40);
});

test('filter indexes are reused and invalidated views reflect changes', async (t) => {
  const store = new Store();
  t.after(() => store.close());
  const page = await store.page('available', '99999', 0);
  assert.equal(page.items.length, 19);
  const index = store.filterIndex.cache.get('99999');
  store.select('999999', true);
  store.add('custom-99999');
  const next = await store.page('available', '99999', 0);
  assert.equal(next.items.includes('999999'), false);
  assert.equal(next.items.includes('custom-99999'), true);
  assert.equal(next.total, page.total);
  assert.equal(store.filterIndex.cache.get('99999'), index);
});
