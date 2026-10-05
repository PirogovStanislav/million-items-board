const express = require('express');
const path = require('node:path');
const { Store, ApiError, normalizeId } = require('./store');
const { Batcher } = require('./batcher');

function queryValue(value) {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > 100) throw new ApiError(400, 'Фильтр должен быть строкой до 100 символов.');
  return value.trim();
}

function createApp(options = {}) {
  const app = express();
  // Один Store на процесс: все клиенты видят общий выбор и порядок до перезапуска сервера.
  const store = new Store(options.initialCount);
  const batcher = new Batcher(store, options);
  let activeRequests = 0;
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));
  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (activeRequests >= 20_000) {
      res.set('Retry-After', '1');
      return res.status(503).json({ error: 'Слишком много одновременных запросов. Повторите позже.' });
    }
    activeRequests += 1;
    res.once('close', () => { activeRequests -= 1; });
    next();
  });

  app.get('/api/items', async (req, res) => {
    const side = req.query.side || 'available';
    if (!['available', 'selected'].includes(side)) throw new ApiError(400, 'Неизвестная панель.');
    const query = queryValue(req.query.q);
    const rawOffset = req.query.offset === undefined ? '0' : req.query.offset;
    const offset = Number(rawOffset);
    if (typeof rawOffset !== 'string' || !/^\d+$/.test(rawOffset) || !Number.isSafeInteger(offset)) {
      throw new ApiError(400, 'Offset должен быть неотрицательным целым числом.');
    }
    if (req.query.limit !== undefined && req.query.limit !== '20') throw new ApiError(400, 'Размер страницы — 20 элементов.');
    const page = await batcher.read(JSON.stringify(['items', side, query, offset]), () => store.page(side, query, offset), side === 'available' ? query : null);
    res.json(page);
  });
  app.get('/api/state', async (_req, res) => {
    res.json(await batcher.read('state', () => store.state()));
  });
  app.get('/api/operations/:id', async (req, res) => {
    res.json(await batcher.read(JSON.stringify(['operation', req.params.id]), () => {
      const operation = batcher.operations.get(req.params.id);
      if (!operation) throw new ApiError(404, 'Операция не найдена или срок её хранения истёк.');
      const { signature, ...result } = operation;
      return result;
    }));
  });

  function enqueue(req, res, type, payload) {
    const key = req.get('Idempotency-Key');
    if (key && (key.length > 100 || !/^[\w.-]+$/.test(key))) throw new ApiError(400, 'Некорректный Idempotency-Key.');
    const operation = batcher.enqueue(type, payload, key);
    // 202 подтверждает постановку в очередь, но не успех: результат доступен по operationId.
    res.status(202).json({
      operationId: operation.id, status: operation.status, deduplicated: Boolean(operation.deduplicated),
      batchIn: type === 'add' ? batcher.addIntervalMs : batcher.intervalMs,
    });
  }
  app.post('/api/items', (req, res) => enqueue(req, res, 'add', { id: normalizeId(req.body?.id) }));
  app.post('/api/selected', (req, res) => enqueue(req, res, 'select', { id: normalizeId(req.body?.id) }));
  app.delete('/api/selected', (req, res) => enqueue(req, res, 'unselect', { id: normalizeId(req.body?.id) }));
  app.post('/api/selected/move', (req, res) => {
    const id = normalizeId(req.body?.id);
    const targetId = normalizeId(req.body?.targetId);
    const position = req.body?.position;
    if (!['before', 'after'].includes(position)) throw new ApiError(400, 'Position должен быть before или after.');
    enqueue(req, res, 'move', { id, targetId, position, query: queryValue(req.body?.query) });
  });
  app.use('/api', (_req, _res, next) => next(new ApiError(404, 'Маршрут не найден.')));
  app.get('/favicon.ico', (_req, res) => res.redirect(302, '/favicon.svg'));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use((_req, _res, next) => next(new ApiError(404, 'Страница не найдена.')));
  app.use((error, _req, res, _next) => {
    const status = error.status || 500;
    if (status === 503) res.set('Retry-After', '1');
    if (status >= 500 && status !== 503) console.error(error);
    res.status(status).json({ error: status === 500 ? 'Ошибка сервера.' : error.type === 'entity.parse.failed' ? 'Некорректный JSON.' : error.message });
  });
  return { app, store, batcher, close: () => batcher.close() };
}

module.exports = { createApp };
