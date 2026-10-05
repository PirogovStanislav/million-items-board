const path = require('node:path');
const { Worker } = require('node:worker_threads');

class FilterIndex {
  constructor(initialCount, cacheSize = 8) {
    this.cache = new Map();
    this.pending = new Map();
    this.waiters = new Map();
    this.cacheSize = cacheSize;
    this.nextId = 1;
    this.worker = new Worker(path.join(__dirname, 'filter-worker.js'), { workerData: { initialCount } });
    this.worker.on('message', ({ requestId, ids }) => {
      const waiter = this.waiters.get(requestId);
      if (!waiter) return;
      this.waiters.delete(requestId);
      this.pending.delete(waiter.query);
      this.cache.set(waiter.query, ids);
      while (this.cache.size > this.cacheSize) this.cache.delete(this.cache.keys().next().value);
      waiter.resolve(ids);
    });
    this.worker.on('error', (error) => this.fail(error));
    this.worker.on('exit', () => this.fail(new Error('Filter worker stopped.')));
  }

  fail(error) {
    this.error = error;
    for (const waiter of this.waiters.values()) waiter.reject(error);
    this.waiters.clear();
    this.pending.clear();
  }

  get(query) {
    if (this.error) return Promise.reject(this.error);
    if (this.cache.has(query)) {
      const ids = this.cache.get(query);
      this.cache.delete(query);
      this.cache.set(query, ids);
      return Promise.resolve(ids);
    }
    if (this.pending.has(query)) return this.pending.get(query);
    const requestId = this.nextId++;
    const promise = new Promise((resolve, reject) => {
      this.waiters.set(requestId, { query, resolve, reject });
      this.worker.postMessage({ requestId, query });
    });
    this.pending.set(query, promise);
    return promise;
  }

  close() { return this.worker.terminate(); }
}

module.exports = { FilterIndex };
