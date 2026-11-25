import type { AuthorizationActor } from "./authorization.js";

/** Include every public authorization input, including key/run scopes and the
 * responsible user's membership. Request-local authorization memos are outputs. */
export function attentionReaderKey(companyId: string, userId: string | null | undefined, actor?: AuthorizationActor) {
  return JSON.stringify([companyId, userId ?? null, actor], (key, value) =>
    key === "__responsibleUserSnapshotMemo" ? undefined : value);
}

/** Only overlapping reads share work. Neither successful nor failed results are cached. */
export function attentionReadCoalescer<T>() {
  const pending = new Map<string, Promise<T>>();
  return {
    get: (key: string) => pending.get(key),
    run(key: string, read: () => Promise<T>): Promise<T> {
      const existing = pending.get(key);
      if (existing) return existing;
      const result = Promise.resolve().then(read).finally(() => {
        if (pending.get(key) === result) pending.delete(key);
      });
      pending.set(key, result);
      return result;
    },
  };
}
