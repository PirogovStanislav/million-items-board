const PAGE_SIZE = 20;
const ROW_HEIGHT = 53;
const CACHE_PAGES = 6;
const MAX_TRACK_HEIGHT = 8_000_000;
const sides = ['available', 'selected'];
const panels = Object.fromEntries(sides.map((side) => {
  const viewport = document.querySelector(`#${side}-viewport`);
  const list = document.querySelector(`#${side}-list`);
  const track = document.createElement('div');
  track.className = 'virtual-track';
  viewport.prepend(track);
  track.append(list);
  return [side, {
    side, viewport, list, track,
    filter: document.querySelector(`#${side}-filter`),
    loader: document.querySelector(`#${side}-loader`),
    meta: document.querySelector(`#${side}-meta`),
    pages: new Map(), requests: new Map(), generation: 0,
    controller: new AbortController(), query: '', total: 0, revision: null,
    loaded: false, failed: false,
    lastScroll: 0, lastLogicalScroll: 0,
  }];
}));

let busyCount = 0;
let stateRevision = -1;
let drag = null;
const pendingIds = new Set();

function updateStatus() {
  const busy = busyCount > 0 || sides.some((side) => panels[side].requests.size > 0);
  const error = sides.some((side) => panels[side].failed);
  const status = document.querySelector('#server-status');
  status.classList.toggle('is-busy', busy);
  status.classList.toggle('is-error', error);
  status.lastChild.textContent = error ? ' Ошибка загрузки' : busy ? ' Сохранение / загрузка…' : ' Синхронизировано';
}

function toast(message, error = false) {
  const element = document.createElement('div');
  element.className = `toast${error ? ' error' : ''}`;
  element.textContent = message;
  const region = document.querySelector('#toast-region');
  while (region.children.length >= 3) region.firstChild.remove();
  region.append(element);
  setTimeout(() => element.remove(), 5000);
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options, headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Не удалось выполнить запрос.');
  return data;
}

function updateCounts(state) {
  if (state.revision < stateRevision) return;
  stateRevision = state.revision;
  document.querySelector('#available-count').textContent = state.availableCount.toLocaleString('ru-RU');
  document.querySelector('#selected-count').textContent = state.selectedCount.toLocaleString('ru-RU');
}

function reset(side, preserveScroll = false) {
  const panel = panels[side];
  const scrollTop = preserveScroll ? panel.viewport.scrollTop : 0;
  // Отменяем старую загрузку; generation также защищает от уже пришедшего устаревшего ответа.
  panel.controller.abort();
  panel.controller = new AbortController();
  panel.generation += 1;
  panel.pages.clear();
  panel.requests.clear();
  panel.revision = null;
  panel.loaded = false;
  panel.failed = false;
  panel.query = panel.filter.value.trim();
  panel.list.replaceChildren();
  if (!preserveScroll) {
    panel.total = 0;
    panel.track.style.height = '0px';
  }
  panel.viewport.scrollTop = scrollTop;
  panel.lastScroll = panel.viewport.scrollTop;
  panel.lastLogicalScroll = logicalScroll(panel);
  panel.meta.textContent = 'Загрузка…';
  if (side === 'selected') document.querySelector('#selected-empty').hidden = true;
  updateStatus();
}

function remember(panel, offset, items) {
  panel.pages.delete(offset);
  panel.pages.set(offset, items);
  while (panel.pages.size > CACHE_PAGES) panel.pages.delete(panel.pages.keys().next().value);
}

async function fetchPage(side, offset) {
  const panel = panels[side];
  if (panel.pages.has(offset)) return;
  if (panel.requests.has(offset)) return panel.requests.get(offset);
  const generation = panel.generation;
  const signal = panel.controller.signal;
  const request = (async () => {
    try {
      const params = new URLSearchParams({ side, q: panel.query, offset: String(offset), limit: '20' });
      const page = await api(`/api/items?${params}`, { signal });
      if (generation !== panel.generation) return;
      if (panel.revision !== null && page.revision !== panel.revision) {
        // Другой клиент изменил общее состояние: страницы разных ревизий смешивать нельзя.
        reset(side, true);
        requestVisible(side);
        return;
      }
      panel.revision = page.revision;
      panel.total = page.total;
      panel.loaded = true;
      panel.failed = false;
      remember(panel, offset, page.items);
      updateCounts(page.state);
      render(side);
      requestVisible(side);
    } catch (error) {
      if (error.name !== 'AbortError' && generation === panel.generation) {
        panel.failed = true;
        toast(error.message, true);
        panel.meta.textContent = 'Не удалось загрузить. Нажмите «Повторить».';
      }
    } finally {
      if (generation === panel.generation) {
        panel.requests.delete(offset);
        panel.loader.hidden = panel.requests.size === 0 && !panel.failed;
        panel.loader.textContent = panel.failed ? 'Повторить загрузку' : 'Загрузка…';
      }
      updateStatus();
    }
  })();
  panel.requests.set(offset, request);
  panel.loader.hidden = false;
  panel.loader.textContent = 'Загрузка…';
  updateStatus();
  return request;
}

function trackHeight(panel) { return Math.min(panel.total * ROW_HEIGHT, MAX_TRACK_HEIGHT); }

function logicalScroll(panel) {
  // Сжатая высота трека позволяет достичь миллионной строки без огромного DOM-контейнера.
  const physicalRange = Math.max(1, trackHeight(panel) - panel.viewport.clientHeight);
  const logicalRange = Math.max(0, panel.total * ROW_HEIGHT - panel.viewport.clientHeight);
  return panel.viewport.scrollTop * logicalRange / physicalRange;
}

function setLogicalScroll(panel, value) {
  const logicalRange = Math.max(0, panel.total * ROW_HEIGHT - panel.viewport.clientHeight);
  const physicalRange = Math.max(0, trackHeight(panel) - panel.viewport.clientHeight);
  panel.viewport.scrollTop = logicalRange ? Math.max(0, Math.min(value, logicalRange)) * physicalRange / logicalRange : 0;
  panel.lastScroll = panel.viewport.scrollTop;
  panel.lastLogicalScroll = logicalScroll(panel);
}

function windowStart(panel) {
  return Math.max(0, Math.min(Math.floor(logicalScroll(panel) / ROW_HEIGHT), panel.total - PAGE_SIZE));
}

function requestVisible(side) {
  const panel = panels[side];
  if (panel.failed) return;
  if (!panel.loaded) return fetchPage(side, Math.floor(windowStart(panel) / PAGE_SIZE) * PAGE_SIZE);
  if (!panel.total) return;
  const start = windowStart(panel);
  const end = Math.min(panel.total - 1, start + PAGE_SIZE - 1);
  const promises = [];
  for (let offset = Math.floor(start / PAGE_SIZE) * PAGE_SIZE; offset <= end; offset += PAGE_SIZE) {
    promises.push(fetchPage(side, offset));
  }
  return Promise.all(promises);
}

function render(side) {
  const panel = panels[side];
  panel.track.style.height = `${trackHeight(panel)}px`;
  const maxScroll = Math.max(0, trackHeight(panel) - panel.viewport.clientHeight);
  if (panel.viewport.scrollTop > maxScroll) panel.viewport.scrollTop = maxScroll;
  const start = windowStart(panel);
  panel.list.style.top = `${panel.viewport.scrollTop + start * ROW_HEIGHT - logicalScroll(panel)}px`;
  const focusId = panel.list.contains(document.activeElement) ? document.activeElement.closest('[data-id]')?.dataset.id : null;
  const fragment = document.createDocumentFragment();
  // В DOM держим окно максимум из 20 строк, независимо от глубины прокрутки и фильтра.
  for (let index = start; index < Math.min(panel.total, start + PAGE_SIZE); index += 1) {
    const offset = Math.floor(index / PAGE_SIZE) * PAGE_SIZE;
    const id = panel.pages.get(offset)?.[index - offset];
    if (id !== undefined) fragment.append(createRow(side, id));
    else {
      const placeholder = document.createElement('div');
      placeholder.className = 'item-placeholder';
      placeholder.setAttribute('aria-hidden', 'true');
      fragment.append(placeholder);
    }
  }
  panel.list.replaceChildren(fragment);
  if (focusId) [...panel.list.querySelectorAll('[data-id]')].find((row) => row.dataset.id === focusId)?.querySelector('.item-action')?.focus({ preventScroll: true });
  panel.meta.textContent = panel.total
    ? `${start + 1}–${Math.min(start + 20, panel.total)} из ${panel.total.toLocaleString('ru-RU')}`
    : panel.loaded ? 'Нет результатов' : 'Загрузка…';
  if (side === 'selected') {
    const empty = document.querySelector('#selected-empty');
    empty.hidden = !panel.loaded || panel.total > 0;
    empty.querySelector('strong').textContent = panel.query ? 'Совпадений нет' : 'Пока ничего не выбрано';
    empty.querySelector('span').textContent = panel.query ? 'Измените или очистите фильтр.' : 'Нажмите на элемент слева, чтобы добавить его сюда.';
  }
}

function createRow(side, id) {
  const row = document.createElement('div');
  row.className = `item-row${drag?.id === id ? ' is-dragging' : ''}`;
  row.dataset.id = id;
  row.setAttribute('role', 'listitem');
  if (side === 'selected') {
    const handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'drag-handle';
    handle.textContent = '⋮⋮';
    handle.setAttribute('aria-label', `Переместить ${id}. Alt и стрелки для сортировки.`);
    handle.disabled = pendingIds.has(id);
    handle.addEventListener('pointerdown', (event) => beginDrag(event, id));
    handle.addEventListener('keydown', (event) => keyboardMove(event, id));
    row.append(handle);
  }
  const label = document.createElement('span');
  label.className = 'item-id';
  // Произвольный ID выводим как текст, чтобы он не интерпретировался как HTML.
  label.textContent = id;
  row.append(label);
  const action = document.createElement('button');
  action.type = 'button';
  action.className = 'item-action';
  action.textContent = side === 'available' ? '+' : '×';
  action.setAttribute('aria-label', side === 'available' ? `Выбрать ${id}` : `Убрать ${id}`);
  action.disabled = pendingIds.has(id);
  action.addEventListener('click', () => mutate('/api/selected', { id }, side === 'available' ? 'POST' : 'DELETE'));
  row.append(action);
  return row;
}

async function waitForOperation(id) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    // Чтение статуса тоже ждёт секундного батча; не считаем HTTP 202 выполненной операцией.
    const operation = await api(`/api/operations/${encodeURIComponent(id)}`);
    if (operation.status === 'applied') return;
    if (operation.status === 'rejected') throw new Error(operation.error);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Операция ещё обрабатывается. Обновите список позже.');
}

async function reloadLists() {
  for (const side of sides) reset(side, true);
  await Promise.all(sides.map(requestVisible));
}

async function mutate(url, payload, method = 'POST') {
  if (pendingIds.has(payload.id)) return false;
  pendingIds.add(payload.id);
  busyCount += 1;
  sides.forEach(render);
  updateStatus();
  try {
    const result = await api(url, {
      method, body: JSON.stringify(payload), headers: { 'Idempotency-Key': crypto.randomUUID() },
    });
    if (url === '/api/items') toast(`ID ${payload.id} сохраняется. Это займёт до 10 секунд.`);
    await waitForOperation(result.operationId);
    await reloadLists();
    if (url === '/api/items') toast(`ID ${payload.id} добавлен. Найти его можно через фильтр.`);
    return true;
  } catch (error) { toast(error.message, true); return false; }
  finally {
    pendingIds.delete(payload.id);
    busyCount -= 1;
    sides.forEach(render);
    updateStatus();
  }
}

function beginDrag(event, id) {
  if (event.button !== 0 || pendingIds.has(id)) return;
  const viewport = panels.selected.viewport;
  drag = { id, pointerId: event.pointerId, startY: event.clientY, x: event.clientX, y: event.clientY, active: false, targetId: null };
  // Захватываем указатель на viewport: строки могут пересоздаваться во время автопрокрутки.
  viewport.setPointerCapture(event.pointerId);
  event.preventDefault();
}

function updateDragTarget() {
  if (!drag?.active) return;
  const viewport = panels.selected.viewport;
  const bounds = viewport.getBoundingClientRect();
  const node = document.elementFromPoint(drag.x, drag.y)?.closest('.item-row');
  panels.selected.list.querySelectorAll('.drag-before, .drag-after').forEach((row) => row.classList.remove('drag-before', 'drag-after'));
  drag.targetId = node && viewport.contains(node) && node.dataset.id !== drag.id ? node.dataset.id : null;
  if (drag.targetId) {
    drag.position = drag.y < node.getBoundingClientRect().top + 23 ? 'before' : 'after';
    node.classList.add(`drag-${drag.position}`);
  }
  const inside = drag.x >= bounds.left && drag.x <= bounds.right && drag.y >= bounds.top && drag.y <= bounds.bottom;
  drag.scrollSpeed = inside ? drag.y < bounds.top + 45 ? -9 : drag.y > bounds.bottom - 45 ? 9 : 0 : 0;
}

function dragFrame() {
  if (!drag?.active) return;
  if (drag.scrollSpeed) setLogicalScroll(panels.selected, logicalScroll(panels.selected) + drag.scrollSpeed);
  updateDragTarget();
  drag.frame = requestAnimationFrame(dragFrame);
}

function finishDrag(event, cancelled = false) {
  if (!drag || drag.pointerId !== event.pointerId) return;
  const saved = drag;
  drag = null;
  cancelAnimationFrame(saved.frame);
  if (panels.selected.viewport.hasPointerCapture(event.pointerId)) panels.selected.viewport.releasePointerCapture(event.pointerId);
  render('selected');
  if (!cancelled && saved.active && saved.targetId) {
    // Отправляем ID и фильтр, а не индексы видимой страницы: порядок определяет сервер.
    mutate('/api/selected/move', { id: saved.id, targetId: saved.targetId, position: saved.position, query: panels.selected.query });
  }
}

panels.selected.viewport.addEventListener('pointermove', (event) => {
  if (!drag || drag.pointerId !== event.pointerId) return;
  drag.x = event.clientX;
  drag.y = event.clientY;
  if (!drag.active && Math.abs(drag.y - drag.startY) > 4) {
    drag.active = true;
    render('selected');
    dragFrame();
  }
  updateDragTarget();
});
panels.selected.viewport.addEventListener('pointerup', (event) => finishDrag(event));
panels.selected.viewport.addEventListener('pointercancel', (event) => finishDrag(event, true));
panels.selected.viewport.addEventListener('lostpointercapture', (event) => finishDrag(event, true));

async function keyboardMove(event, id) {
  if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
  event.preventDefault();
  const panel = panels.selected;
  let index = -1;
  for (const [offset, items] of panel.pages) {
    const local = items.indexOf(id);
    if (local >= 0) { index = offset + local; break; }
  }
  const targetIndex = index + (event.key === 'ArrowUp' ? -1 : 1);
  if (index < 0 || targetIndex < 0 || targetIndex >= panel.total) return;
  const offset = Math.floor(targetIndex / 20) * 20;
  await fetchPage('selected', offset);
  const targetId = panel.pages.get(offset)?.[targetIndex - offset];
  if (targetId) await mutate('/api/selected/move', { id, targetId, position: event.key === 'ArrowUp' ? 'before' : 'after', query: panel.query });
}

document.querySelector('#add-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = document.querySelector('#new-id');
  const id = input.value.trim();
  if (!id) return;
  if (await mutate('/api/items', { id }) && input.value.trim() === id) input.value = '';
});

for (const side of sides) {
  const panel = panels[side];
  // Сбрасываем фильтр явно, даже если браузер восстановил значения полей после обновления.
  panel.filter.value = '';
  let debounce;
  let frame;
  panel.filter.addEventListener('input', () => {
    clearTimeout(debounce);
    reset(side);
    debounce = setTimeout(() => requestVisible(side), 180);
  });
  panel.viewport.addEventListener('scroll', () => {
    const delta = panel.viewport.scrollTop - panel.lastScroll;
    // Колесо, касания и фокус двигаются в пикселях строк; большие скачки полосы прокрутки
    // используют сжатый диапазон, чтобы можно было добраться до миллионной строки.
    if (panel.total * ROW_HEIGHT > MAX_TRACK_HEIGHT && Math.abs(delta) < panel.viewport.clientHeight * 2) {
      setLogicalScroll(panel, panel.lastLogicalScroll + delta);
    } else {
      panel.lastScroll = panel.viewport.scrollTop;
      panel.lastLogicalScroll = logicalScroll(panel);
    }
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => { render(side); requestVisible(side); });
  });
  panel.viewport.addEventListener('keydown', (event) => {
    if (event.target !== panel.viewport || !['Home', 'End', 'PageDown', 'PageUp', 'ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    const value = event.key === 'Home' ? 0 : event.key === 'End' ? panel.total * ROW_HEIGHT
      : logicalScroll(panel) + ({ PageDown: panel.viewport.clientHeight, PageUp: -panel.viewport.clientHeight, ArrowDown: ROW_HEIGHT, ArrowUp: -ROW_HEIGHT })[event.key];
    setLogicalScroll(panel, value);
    render(side);
    requestVisible(side);
  });
  panel.loader.addEventListener('click', () => { panel.failed = false; requestVisible(side); });
  new ResizeObserver(() => {
    if (panel.loaded) {
      render(side);
      panel.lastScroll = panel.viewport.scrollTop;
      panel.lastLogicalScroll = logicalScroll(panel);
      requestVisible(side);
    }
  }).observe(panel.viewport);
  document.querySelector(`[data-clear="${side}-filter"]`).addEventListener('click', () => {
    clearTimeout(debounce);
    panel.filter.value = '';
    reset(side);
    requestVisible(side);
  });
  reset(side);
  requestVisible(side);
}
