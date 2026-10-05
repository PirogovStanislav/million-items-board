const { randomUUID } = require('node:crypto');
const { ApiError } = require('./store');

class Batcher {
  constructor(store, { intervalMs = 1000, addIntervalMs = 10_000, maxQueue = 10_000, maxReads = 2000, retentionMs = 300_000, autoStart = true } = {}) {
    Object.assign(this, { store, intervalMs, addIntervalMs, maxQueue, maxReads, retentionMs });
    this.operations = new Map();
    this.idempotency = new Map();
    this.adds = new Map();
    this.mutations = [];
    this.selectionReservations = new Map();
    this.lastMutation = null;
    this.reads = new Map();
    this.lastAddAt = Date.now();
    this.flushing = false;
    this.closed = false;
    this.stats = { batches: 0, readsComputed: 0, readsDeduplicated: 0, writesDeduplicated: 0 };
    if (autoStart) this.timer = setInterval(() => this.flush().catch(console.error), intervalMs);
  }

  prune(now = Date.now()) {
    for (const [id, operation] of this.operations) {
      if (operation.completedAt && now - operation.completedAt >= this.retentionMs) this.operations.delete(id);
    }
    for (const [key, record] of this.idempotency) {
      if (!this.operations.has(record.operationId)) this.idempotency.delete(key);
    }
  }

  enqueue(type, payload, key) {
    if (this.closed) throw new ApiError(503, 'Сервер останавливается.');
    const signature = JSON.stringify([type, payload]);
    if (key && this.idempotency.has(key)) {
      const record = this.idempotency.get(key);
      if (record.signature !== signature) throw new ApiError(409, 'Idempotency-Key уже использован для другого запроса.');
      this.stats.writesDeduplicated += 1;
      return { ...this.operations.get(record.operationId), deduplicated: true };
    }
    if (key && this.idempotency.size >= this.maxQueue * 2) throw new ApiError(503, 'Лимит ключей повторных запросов исчерпан. Повторите позже.');
    let duplicate;
    if (type === 'add') {
      if (this.store.exists(payload.id)) throw new ApiError(409, 'Элемент с таким ID уже существует.');
      // Резервируем ID до десятисекундного батча: повторы получат ту же операцию.
      duplicate = this.adds.get(payload.id);
    } else if (type === 'select' || type === 'unselect') {
      const reservation = this.selectionReservations.get(payload.id);
      if (reservation?.signature === signature) duplicate = reservation;
    } else if (this.lastMutation?.signature === signature) duplicate = this.lastMutation;
    if (duplicate) {
      if (key) this.idempotency.set(key, { signature, operationId: duplicate.id });
      this.stats.writesDeduplicated += 1;
      return { ...this.operations.get(duplicate.id), deduplicated: true };
    }
    if (this.mutations.length + this.adds.size >= this.maxQueue || this.operations.size >= this.maxQueue * 2) {
      throw new ApiError(503, 'Очередь заполнена. Повторите запрос позже.');
    }
    const operation = { id: randomUUID(), type, payload, status: 'queued', createdAt: Date.now(), signature };
    this.operations.set(operation.id, operation);
    if (key) this.idempotency.set(key, { signature, operationId: operation.id });
    if (type === 'add') this.adds.set(payload.id, operation);
    else {
      // Противоположные действия сохраняем в FIFO, иначе select → unselect → select потеряет порядок.
      this.mutations.push(operation);
      this.lastMutation = operation;
      if (type === 'select' || type === 'unselect') this.selectionReservations.set(payload.id, operation);
    }
    return operation;
  }

  read(key, compute, filterQuery = null) {
    if (this.closed) return Promise.reject(new ApiError(503, 'Сервер останавливается.'));
    if (this.reads.has(key)) {
      // Одно вычисление и один Promise на одинаковые чтения внутри очереди.
      this.stats.readsDeduplicated += 1;
      return this.reads.get(key).promise;
    }
    if (this.reads.size >= this.maxReads) return Promise.reject(new ApiError(503, 'Очередь чтения заполнена. Повторите запрос позже.'));
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    this.reads.set(key, { promise, compute, resolve, reject, filterQuery });
    return promise;
  }

  apply(operation) {
    try {
      if (operation.type === 'add') this.store.add(operation.payload.id);
      else if (operation.type === 'move') this.store.move(operation.payload);
      else this.store.select(operation.payload.id, operation.type === 'select');
      operation.status = 'applied';
    } catch (error) {
      operation.status = 'rejected';
      operation.error = error.message;
      operation.errorStatus = error.status || 500;
    }
    operation.completedAt = Date.now();
    operation.revision = this.store.revision;
  }

  async flush(now = Date.now()) {
    if (this.flushing || this.closed) return;
    this.flushing = true;
    try {
      this.stats.batches += 1;
      this.prune(now);
      if (now - this.lastAddAt >= this.addIntervalMs) {
        // Интервал отсчитывается от старта планировщика, а не от каждого запроса.
        this.lastAddAt = now;
        for (const operation of this.adds.values()) this.apply(operation);
        this.adds.clear();
      }
      const mutations = this.mutations.splice(0, 500);
      this.lastMutation = this.mutations.at(-1) || null;
      const started = Date.now();
      for (let index = 0; index < mutations.length; index += 1) {
        const operation = mutations[index];
        this.apply(operation);
        if (this.selectionReservations.get(operation.payload.id) === operation) this.selectionReservations.delete(operation.payload.id);
        // Уступаем цикл событий, чтобы сервер принимал новые запросы во время большого батча.
        if (index % 16 === 15) await new Promise(setImmediate);
        if (Date.now() - started > 200) {
          this.mutations.unshift(...mutations.slice(index + 1));
          break;
        }
      }
      this.lastMutation = this.mutations.at(-1) || null;
      const reads = [];
      const filters = new Set();
      // Ограничиваем дорогие холодные фильтры за один тик; остальные чтения остаются в очереди.
      for (const [key, read] of this.reads) {
        if (reads.length >= 256) break;
        if (read.filterQuery && !filters.has(read.filterQuery) && filters.size >= 8) continue;
        if (read.filterQuery) filters.add(read.filterQuery);
        reads.push(read);
        this.reads.delete(key);
      }
      // Пока считаются асинхронные страницы, следующий flush не меняет состояние.
      // Все чтения батча получают одну ревизию, новые запросы ждут следующего тика.
      await Promise.all(reads.map(async ({ compute, resolve, reject }) => {
        try {
          this.stats.readsComputed += 1;
          resolve(await compute());
        } catch (error) { reject(error); }
      }));
    } finally { this.flushing = false; }
  }

  close() {
    this.closed = true;
    clearInterval(this.timer);
    for (const read of this.reads.values()) read.reject(new ApiError(503, 'Сервер останавливается.'));
    this.reads.clear();
    return this.store.close();
  }
}

module.exports = { Batcher };
