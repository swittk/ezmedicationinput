/**
 * A small time-ordered queue for genuinely overlapping treatment cycles.
 *
 * It intentionally owns only timestamp ordering. The clinical recurrence,
 * counting, rolling dose caps and supply decisions stay with execution/engine.
 * A future cycle cannot emit before its own start, so engine.ts drains every
 * event earlier than the next cycle start. This avoids both speculative
 * accepted future doses and repeatedly sorting whole historical arrays.
 */
export interface ChronologicalEvent {
  at: number;
  iso: string;
  /** Stable insertion order for simultaneous administrations. */
  serial: number;
}

export class ChronologicalQueue<T extends ChronologicalEvent> {
  private readonly items: T[] = [];

  get length(): number {
    return this.items.length;
  }

  private earlier(a: T, b: T): boolean {
    return a.at < b.at || (a.at === b.at && a.serial < b.serial);
  }

  first(): T | undefined {
    return this.items[0];
  }

  push(item: T): void {
    const heap = this.items;
    let index = heap.length;
    heap.push(item);
    while (index > 0) {
      const parent = (index - 1) >>> 1;
      const previous = heap[parent];
      if (!this.earlier(item, previous)) break;
      heap[index] = previous;
      index = parent;
    }
    heap[index] = item;
  }

  pop(): T | undefined {
    const heap = this.items;
    const top = heap[0];
    if (top === undefined) return undefined;
    const last = heap.pop()!;
    if (heap.length) {
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        if (left >= heap.length) break;
        const right = left + 1;
        const child = right < heap.length && this.earlier(heap[right], heap[left]) ? right : left;
        if (!this.earlier(heap[child], last)) break;
        heap[index] = heap[child];
        index = child;
      }
      heap[index] = last;
    }
    return top;
  }
}
