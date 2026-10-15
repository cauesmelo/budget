import type { FinanceData } from './types';

export interface LocalSaveQueue {
  save(data: FinanceData): Promise<void>;
  /** Waits for the latest state submitted before this call. */
  flush(): Promise<void>;
}

/** Serializes full snapshots immediately, allowing a later save to recover from a failed write. */
export function createLocalSaveQueue(write: (data: FinanceData) => Promise<void>): LocalSaveQueue {
  let latest: Promise<void> = Promise.resolve();
  return {
    save(data) {
      // Capture this revision even when the caller changes an object while a write is pending.
      const snapshot = structuredClone(data);
      const operation = latest.catch(() => {}).then(() => write(snapshot));
      latest = operation;
      return operation;
    },
    flush() { return latest; },
  };
}
