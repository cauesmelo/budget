import { describe, expect, it, vi } from 'vitest';
import { createEmptyData } from '../src/lib/finance';
import { createLocalSaveQueue } from '../src/lib/localSave';
import type { FinanceData } from '../src/lib/types';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((success, failure) => { resolve = success; reject = failure; });
  return { promise, resolve, reject };
}
function revision(amount: number): FinanceData {
  const data = createEmptyData(new Date('2032-10-10T12:00:00.000Z'));
  data.settings.initialReserveCents = amount;
  return data;
}
const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));

describe('local save queue', () => {
  it('starts persistence without a debounce timer and flushes an empty queue', async () => {
    const write = vi.fn(async () => {});
    const queue = createLocalSaveQueue(write);
    await queue.flush();
    const saved = queue.save(revision(100));
    await nextTurn();
    expect(write).toHaveBeenCalledOnce();
    await saved;
    await queue.flush();
  });

  it('serializes writes so an older pending revision cannot overwrite a newer one', async () => {
    const first = deferred();
    const second = deferred();
    const writes: number[] = [];
    let stored = 0;
    const queue = createLocalSaveQueue(async data => {
      const amount = data.settings.initialReserveCents;
      writes.push(amount);
      await (amount === 100 ? first.promise : second.promise);
      stored = amount;
    });
    let firstResolved = false;
    let secondResolved = false;
    const savingFirst = queue.save(revision(100)).then(() => { firstResolved = true; });
    const savingSecond = queue.save(revision(200)).then(() => { secondResolved = true; });
    const flushing = queue.flush();
    await nextTurn();
    expect(writes).toEqual([100]);
    expect(firstResolved).toBe(false);
    first.resolve();
    await savingFirst;
    await nextTurn();
    expect(writes).toEqual([100, 200]);
    expect(stored).toBe(100);
    expect(secondResolved).toBe(false);
    second.resolve();
    await Promise.all([savingSecond, flushing]);
    expect(stored).toBe(200);
    expect(firstResolved && secondResolved).toBe(true);
  });

  it('does not let a failed write poison later full-state saves', async () => {
    const first = deferred();
    const error = new Error('Storage unavailable');
    const write = vi.fn(async data => {
      if (data.settings.initialReserveCents === 100) await first.promise;
    });
    const queue = createLocalSaveQueue(write);
    const savingFirst = queue.save(revision(100));
    const firstFailure = expect(savingFirst).rejects.toBe(error);
    const savingSecond = queue.save(revision(200));
    first.reject(error);
    await firstFailure;
    await savingSecond;
    await expect(queue.flush()).resolves.toBeUndefined();
    expect(write.mock.calls.map(([data]) => data.settings.initialReserveCents)).toEqual([100, 200]);
  });

  it('reports the most recent failed revision through flush', async () => {
    const error = new Error('Quota exceeded');
    const queue = createLocalSaveQueue(async () => { throw error; });
    await expect(queue.save(revision(100))).rejects.toBe(error);
    await expect(queue.flush()).rejects.toBe(error);
  });

  it('captures each submitted snapshot before a caller can mutate it', async () => {
    const first = deferred();
    const received: FinanceData[] = [];
    const queue = createLocalSaveQueue(async data => {
      received.push(data);
      if (received.length === 1) await first.promise;
    });
    const original = revision(100);
    const firstSave = queue.save(original);
    const pending = revision(200);
    const secondSave = queue.save(pending);
    original.settings.initialReserveCents = 999;
    pending.settings.initialReserveCents = 999;
    first.resolve();
    await Promise.all([firstSave, secondSave]);
    expect(received.map(data => data.settings.initialReserveCents)).toEqual([100, 200]);
    expect(received[0]).not.toBe(original);
    expect(received[1]).not.toBe(pending);
  });

  it('also recovers from a synchronous writer failure', async () => {
    let attempts = 0;
    const queue = createLocalSaveQueue(() => {
      attempts++;
      if (attempts === 1) throw new Error('Blocked');
      return Promise.resolve();
    });
    await expect(queue.save(revision(100))).rejects.toThrow('Blocked');
    await queue.save(revision(200));
    await queue.flush();
    expect(attempts).toBe(2);
  });
});
