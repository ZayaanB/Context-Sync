/** Binary heap: O(log n) insertion/removal, O(1) minimum lookup. */
export class MinHeap<T> {
  private readonly _items: T[] = [];

  constructor(private readonly _compare: (a: T, b: T) => number) {}

  get size(): number { return this._items.length; }

  public push(value: T): void {
    const items = this._items;
    items.push(value);
    let index = items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >>> 1;
      if (this._compare(items[parent], items[index]) <= 0) break;
      [items[parent], items[index]] = [items[index], items[parent]];
      index = parent;
    }
  }

  public pop(): T | undefined {
    const items = this._items;
    if (!items.length) return undefined;
    const minimum = items[0];
    const tail = items.pop()!;
    if (items.length) {
      items[0] = tail;
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        if (left >= items.length) break;
        const right = left + 1;
        const child = right < items.length && this._compare(items[right], items[left]) < 0 ? right : left;
        if (this._compare(items[index], items[child]) <= 0) break;
        [items[index], items[child]] = [items[child], items[index]];
        index = child;
      }
    }
    return minimum;
  }
}
