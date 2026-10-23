// The consent adapter is the only thing this library asks of your consent
// manager. It is a plain object with two methods:
//
//   getState()        -> 'granted' | 'denied' | 'unknown'
//   subscribe(cb)     -> unsubscribe function; cb is called when the state changes
//
// An opt-out ("do not sell or share") is the state 'denied'.

export const CONSENT_STATES = Object.freeze(['granted', 'denied', 'unknown']);

/** Anything that is not a known state is treated as 'unknown', so nothing loads. */
export function normalizeState(value) {
  return CONSENT_STATES.includes(value) ? value : 'unknown';
}

export function isConsentAdapter(value) {
  return (
    Boolean(value) && typeof value.getState === 'function' && typeof value.subscribe === 'function'
  );
}

/**
 * An adapter you control by hand, for demos and tests.
 * Besides getState and subscribe it has set(state), grant(), deny() and reset().
 */
export function createMockAdapter(initialState = 'unknown') {
  if (!CONSENT_STATES.includes(initialState)) {
    throw new RangeError(`Unknown consent state: ${String(initialState)}`);
  }
  let state = initialState;
  const listeners = new Set();

  function set(next) {
    if (!CONSENT_STATES.includes(next)) {
      throw new RangeError(`Unknown consent state: ${String(next)}`);
    }
    if (next === state) return;
    state = next;
    for (const listener of [...listeners]) listener(state);
  }

  return {
    getState: () => state,
    subscribe(callback) {
      if (typeof callback !== 'function') throw new TypeError('subscribe needs a function');
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
    set,
    grant: () => set('granted'),
    deny: () => set('denied'),
    reset: () => set('unknown'),
  };
}
