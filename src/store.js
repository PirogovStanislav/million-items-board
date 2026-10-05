const { FilterIndex } = require('./filter-index');

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function normalizeId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) value = String(value);
  if (typeof value !== 'string') throw new ApiError(400, 'ID должен быть строкой или целым числом.');
  const id = value.trim();
  if (!id || id.length > 100 || /[\u0000-\u001f\u007f]/.test(id)) {
    throw new ApiError(400, 'ID должен содержать от 1 до 100 символов без управляющих знаков.');
  }
  return id;
}

// Количество значений <= value в отсортированном массиве.
function upperBound(values, value) {
  let left = 0;
  let right = values.length;
  while (left < right) {
    const middle = (left + right) >>> 1;
    if (values[middle] <= value) left = middle + 1;
    else right = middle;
  }
  return left;
}

class Store {
  constructor(initialCount = 1_000_000) {
    // Исходные ID представлены диапазоном, а не миллионом объектов в памяти.
    this.initialCount = initialCount;
    this.custom = new Set();
    this.selected = [];
    this.selectedSet = new Set();
    this.revision = 0;
    this.filterIndex = new FilterIndex(initialCount);
    this.views = new Map();
    this.pendingViews = new Map();
  }

  isInitial(id) {
    const number = Number(id);
    return Number.isSafeInteger(number) && number >= 1 && number <= this.initialCount && String(number) === id;
  }
  exists(id) { return this.isInitial(id) || this.custom.has(id); }
  changed() { this.revision += 1; this.views.clear(); }

  add(id) {
    // Повторная проверка при применении: проверка на входе API сама по себе недостаточна.
    if (this.exists(id)) throw new ApiError(409, 'Элемент с таким ID уже существует.');
    this.custom.add(id);
    this.changed();
  }

  select(id, selected) {
    if (!this.exists(id)) throw new ApiError(404, 'Элемент не найден.');
    if (this.selectedSet.has(id) === selected) return;
    if (selected) {
      this.selected.push(id);
      this.selectedSet.add(id);
    } else {
      this.selected.splice(this.selected.indexOf(id), 1);
      this.selectedSet.delete(id);
    }
    this.changed();
  }

  move({ id, targetId, position, query }) {
    if (!this.selectedSet.has(id) || !this.selectedSet.has(targetId)) {
      throw new ApiError(409, 'Для сортировки оба элемента должны быть выбраны.');
    }
    if (!id.includes(query) || !targetId.includes(query)) {
      throw new ApiError(400, 'Оба элемента должны соответствовать активному фильтру.');
    }
    if (id === targetId) return;
    if (!query) {
      this.selected.splice(this.selected.indexOf(id), 1);
      this.selected.splice(this.selected.indexOf(targetId) + (position === 'after' ? 1 : 0), 0, id);
      this.changed();
      return;
    }
    // При фильтре меняем только совпавшие ID в их слотах; скрытые элементы остаются на месте.
    const slots = [];
    const visible = [];
    for (let index = 0; index < this.selected.length; index += 1) {
      if (this.selected[index].includes(query)) {
        slots.push(index);
        visible.push(this.selected[index]);
      }
    }
    visible.splice(visible.indexOf(id), 1);
    visible.splice(visible.indexOf(targetId) + (position === 'after' ? 1 : 0), 0, id);
    slots.forEach((slot, index) => { this.selected[slot] = visible[index]; });
    this.changed();
  }

  state() {
    return {
      initialCount: this.initialCount, customCount: this.custom.size,
      selectedCount: this.selected.length,
      availableCount: this.initialCount + this.custom.size - this.selected.length,
      revision: this.revision,
    };
  }

  async view(side, query) {
    const key = JSON.stringify([side, query]);
    if (this.views.has(key)) {
      const view = this.views.get(key);
      this.views.delete(key);
      this.views.set(key, view);
      return view;
    }
    // Параллельные страницы одного фильтра используют общее представление списка.
    if (this.pendingViews.has(key)) return this.pendingViews.get(key);
    const promise = (async () => {
      const initial = side === 'available' && query ? await this.filterIndex.get(query) : null;
      const removed = [];
      const selected = [];
      for (const id of this.selected) {
        if (!id.includes(query)) continue;
        selected.push(id);
        if (this.isInitial(id)) removed.push(Number(id));
      }
      removed.sort((a, b) => a - b);
      const custom = [...this.custom].filter((id) => !this.selectedSet.has(id) && id.includes(query));
      const view = { initial, removed, selected, custom };
      this.views.set(key, view);
      while (this.views.size > 8) this.views.delete(this.views.keys().next().value);
      return view;
    })().finally(() => this.pendingViews.delete(key));
    this.pendingViews.set(key, promise);
    return promise;
  }

  async page(side, query, offset) {
    const { initial, removed, selected, custom } = await this.view(side, query);
    let items;
    let total;
    if (side === 'selected') {
      total = selected.length;
      items = selected.slice(offset, offset + 20);
    } else {
      const baseCount = initial ? initial.length : this.initialCount;
      const availableInitial = baseCount - removed.length;
      total = availableInitial + custom.length;
      items = [];
      if (offset < availableInitial) {
        // Бинарный поиск находит начало глубокой страницы без прохода по предыдущим.
        let low = 0;
        let high = baseCount;
        while (low < high) {
          const middle = (low + high) >>> 1;
          const id = initial ? initial[middle] : middle + 1;
          const availableThroughMiddle = middle + 1 - upperBound(removed, id);
          if (availableThroughMiddle <= offset) low = middle + 1;
          else high = middle;
        }
        for (let index = low; index < baseCount && items.length < 20; index += 1) {
          const id = String(initial ? initial[index] : index + 1);
          if (!this.selectedSet.has(id)) items.push(id);
        }
      }
      // Пользовательские ID идут после исходного диапазона и могут заполнить остаток страницы.
      const customOffset = Math.max(0, offset - availableInitial);
      items.push(...custom.slice(customOffset, customOffset + 20 - items.length));
    }
    return { items, total, offset, limit: 20, hasMore: offset + items.length < total, query, side, revision: this.revision, state: this.state() };
  }

  close() { return this.filterIndex.close(); }
}

module.exports = { Store, ApiError, normalizeId };
