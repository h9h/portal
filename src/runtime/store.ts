type Listener = () => void;

export type ContextStore = {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  subscribe(key: string, listener: Listener): () => void;
};

export function createContextStore(): ContextStore {
  const values = new Map<string, unknown>();
  const listeners = new Map<string, Set<Listener>>();

  return {
    get(key) {
      return values.get(key);
    },
    set(key, value) {
      values.set(key, value);
      const keyListeners = listeners.get(key);
      if (keyListeners) {
        // Snapshot before iterating: a listener unsubscribing itself (or
        // another listener) mid-notify must not corrupt this notification pass.
        for (const listener of [...keyListeners]) listener();
      }
    },
    subscribe(key, listener) {
      let keyListeners = listeners.get(key);
      if (!keyListeners) {
        keyListeners = new Set();
        listeners.set(key, keyListeners);
      }
      keyListeners.add(listener);
      return () => {
        keyListeners!.delete(listener);
        if (keyListeners!.size === 0) listeners.delete(key);
      };
    },
  };
}
