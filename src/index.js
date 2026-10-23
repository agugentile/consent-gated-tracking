import { createLoader } from './loader.js';

export * from './identity.js';
export * from './consent.js';
export { createLoader, resolveEnvironment, ENVIRONMENTS, ENV_STORAGE_KEY } from './loader.js';
export { createMemoryStorage } from './storage.js';

let current = null;

/**
 * Create the page's loader and remember it, so track() can be imported
 * anywhere. Calling init() again shuts the previous loader down first.
 * Takes the same config as createLoader().
 */
export function init(config) {
  if (current) {
    current.destroy();
    current = null;
  }
  current = createLoader(config);
  return current;
}

/** Track an event through the loader created by init(). */
export function track(name, props) {
  if (!current) throw new Error('Call init() before track()');
  return current.track(name, props);
}
