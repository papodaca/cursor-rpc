export class AsyncQueue<T> {
  #items: T[] = [];
  #waiters: Array<(result: IteratorResult<T>) => void> = [];
  #closed = false;
  #error: unknown;

  push(value: T): void {
    if (this.#closed) {
      return;
    }
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter({ value, done: false });
      return;
    }
    this.#items.push(value);
  }

  close(error?: unknown): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#error = error;
    const waiters = this.#waiters.splice(0);
    for (const waiter of waiters) {
      if (error !== undefined) {
        waiter({ value: undefined, done: true });
      } else {
        waiter({ value: undefined, done: true });
      }
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      if (this.#items.length > 0) {
        const value = this.#items.shift() as T;
        yield value;
        continue;
      }
      if (this.#closed) {
        if (this.#error !== undefined) {
          throw this.#error;
        }
        return;
      }
      const next = await new Promise<IteratorResult<T>>((resolve) => {
        this.#waiters.push(resolve);
      });
      if (next.done === true) {
        if (this.#error !== undefined) {
          throw this.#error;
        }
        return;
      }
      yield next.value;
    }
  }
}
