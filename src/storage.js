// Small helpers around Web Storage. Storage can be missing, full, or blocked
// (private modes, sandboxed frames), so every access is wrapped and fails soft.

/**
 * An in-memory object with the same shape as localStorage.
 * Useful for tests, demos, and pages where real storage is unavailable.
 */
export function createMemoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => {
      data.set(key, String(value));
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

/** Look up window.localStorage or window.sessionStorage without ever throwing. */
export function storageFrom(win, name) {
  try {
    return win && win[name] ? win[name] : null;
  } catch {
    return null;
  }
}

export function read(storage, key) {
  try {
    return storage ? storage.getItem(key) : null;
  } catch {
    return null;
  }
}

export function write(storage, key, value) {
  try {
    if (!storage) return false;
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function remove(storage, key) {
  try {
    if (storage) storage.removeItem(key);
  } catch {
    // Nothing useful to do if storage refuses the call.
  }
}
