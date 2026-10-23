// The loader sits between a consent adapter and a list of vendor scripts.
//
//   unknown  -> nothing loads; events wait in a queue
//   granted  -> vendor scripts are injected; queued events are flushed
//   denied   -> scripts are torn down and removed; queued events are dropped
//
// Anything other than 'granted' shuts vendors down, so a consent manager that
// resets to 'unknown' stops them too.

import { isConsentAdapter, normalizeState } from './consent.js';
import {
  clearAttribution,
  getAttribution,
  parseAttribution,
  saveAttribution,
} from './identity.js';
import { read, storageFrom, write } from './storage.js';

export const ENVIRONMENTS = Object.freeze(['prod', 'qa']);

const ENV_PARAM = 'env';
export const ENV_STORAGE_KEY = 'cgt_env';
const DEFAULT_MAX_QUEUE = 100;

function envFromUrl(href) {
  try {
    return new URL(String(href), 'http://placeholder.invalid').searchParams.get(ENV_PARAM);
  } catch {
    return null;
  }
}

/**
 * Pick the environment: `?env=` in the URL wins and is remembered for the
 * session, then the remembered value, then `fallback` (default 'prod').
 */
export function resolveEnvironment({
  href,
  sessionStorage,
  fallback = 'prod',
  allowSwitch = true,
} = {}) {
  if (!ENVIRONMENTS.includes(fallback)) {
    throw new RangeError(`env must be one of ${ENVIRONMENTS.join(', ')}`);
  }
  if (!allowSwitch) return fallback;

  const fromUrl = envFromUrl(href);
  if (ENVIRONMENTS.includes(fromUrl)) {
    write(sessionStorage, ENV_STORAGE_KEY, fromUrl);
    return fromUrl;
  }
  const remembered = read(sessionStorage, ENV_STORAGE_KEY);
  return ENVIRONMENTS.includes(remembered) ? remembered : fallback;
}

function perEnv(value, env) {
  if (typeof value === 'string') return value;
  return value && typeof value === 'object' ? value[env] : undefined;
}

function checkVendors(vendors) {
  if (!Array.isArray(vendors)) throw new TypeError('vendors must be an array');
  const seen = new Set();
  for (const vendor of vendors) {
    if (!vendor || typeof vendor.id !== 'string' || vendor.id === '') {
      throw new TypeError('Each vendor needs a string id');
    }
    if (seen.has(vendor.id)) throw new TypeError(`Duplicate vendor id: ${vendor.id}`);
    seen.add(vendor.id);
    if (!vendor.src) throw new TypeError(`Vendor "${vendor.id}" needs a src`);
  }
}

/**
 * @param {object} config
 * @param {{getState: Function, subscribe: Function}} config.consent  consent adapter
 * @param {object[]} config.vendors  { id, src, integrity?, crossorigin?, onLoad?, onEvent?, teardown? }
 * @param {'prod'|'qa'} [config.env]  default environment (default 'prod')
 * @param {boolean} [config.allowEnvSwitch]  honor ?env= in the URL (default true)
 * @param {Window} [config.window]  defaults to the global window
 * @param {Document} [config.document]  defaults to window.document
 * @param {object} [config.storage]  localStorage-like, for attribution
 * @param {object} [config.sessionStorage]  sessionStorage-like, for the env choice
 * @param {{ttlDays?: number, key?: string}} [config.attribution]
 * @param {number} [config.maxQueue]  most events held while consent is unknown (default 100)
 * @param {Function} [config.onLog]  called with { type, time, ... } for everything the loader does
 * @param {Function} [config.now]  clock, for tests
 */
export function createLoader(config = {}) {
  const { consent, vendors = [] } = config;
  if (!isConsentAdapter(consent)) {
    throw new TypeError('consent must be an adapter with getState() and subscribe()');
  }
  checkVendors(vendors);

  const win = config.window || globalThis.window;
  const doc = config.document || (win && win.document);
  if (!win || !doc) throw new Error('createLoader needs a browser window and document');

  const now = config.now || Date.now;
  const maxQueue = config.maxQueue ?? DEFAULT_MAX_QUEUE;
  const localStore = config.storage !== undefined ? config.storage : storageFrom(win, 'localStorage');
  const sessionStore =
    config.sessionStorage !== undefined ? config.sessionStorage : storageFrom(win, 'sessionStorage');
  const attributionOptions = { ...config.attribution, storage: localStore, now };

  const href = win.location ? win.location.href : '';
  const env = resolveEnvironment({
    href,
    sessionStorage: sessionStore,
    fallback: config.env || 'prod',
    allowSwitch: config.allowEnvSwitch !== false,
  });

  // What the landing URL carried. Kept in memory until consent allows storing it.
  const landing = parseAttribution(href);

  const entries = vendors.map((vendor) => ({
    vendor,
    status: 'idle', // idle | loading | loaded | failed
    attempt: null,
    buffer: [],
  }));

  let state = null;
  let destroyed = false;
  const queue = [];

  function log(entry) {
    if (typeof config.onLog !== 'function') return;
    try {
      config.onLog({ time: now(), ...entry });
    } catch {
      // A broken log handler must not break tracking.
    }
  }

  // Run a vendor hook. A throwing vendor must not stop the others.
  function runHook(vendor, hook, ...args) {
    if (typeof vendor[hook] !== 'function') return;
    try {
      vendor[hook](...args);
    } catch (error) {
      log({ type: 'vendor-error', id: vendor.id, reason: `${hook} threw: ${error.message}` });
    }
  }

  function finalize(item) {
    return {
      name: item.name,
      props: item.props,
      time: item.time,
      attribution: getAttribution(attributionOptions),
    };
  }

  function deliver(event) {
    for (const entry of entries) {
      if (entry.status === 'loaded') {
        runHook(entry.vendor, 'onEvent', event);
      } else if (entry.status === 'loading') {
        entry.buffer.push(event);
        if (entry.buffer.length > maxQueue) entry.buffer.shift();
      }
    }
  }

  function handleLoad(entry, attempt) {
    if (attempt.cancelled) {
      // The script finished after consent was withdrawn. Shut it down right away.
      runHook(entry.vendor, 'teardown', { env });
      log({ type: 'vendor-teardown', id: entry.vendor.id, late: true });
      return;
    }
    entry.status = 'loaded';
    log({ type: 'vendor-loaded', id: entry.vendor.id });
    runHook(entry.vendor, 'onLoad', { env, src: attempt.src });
    const waiting = entry.buffer.splice(0);
    for (const event of waiting) runHook(entry.vendor, 'onEvent', event);
  }

  function handleError(entry, attempt) {
    if (attempt.cancelled) return;
    attempt.script.remove();
    entry.status = 'failed';
    entry.attempt = null;
    entry.buffer.length = 0;
    log({ type: 'vendor-error', id: entry.vendor.id, reason: 'script failed to load' });
  }

  function startVendor(entry) {
    if (entry.status !== 'idle') return;
    const { vendor } = entry;
    const src = perEnv(vendor.src, env);
    if (!src) {
      entry.status = 'failed';
      log({ type: 'vendor-error', id: vendor.id, reason: `no src for env "${env}"` });
      return;
    }

    const script = doc.createElement('script');
    script.async = true;
    script.setAttribute('data-consent-vendor', vendor.id);
    const integrity = perEnv(vendor.integrity, env);
    if (integrity) script.setAttribute('integrity', integrity);
    const crossorigin = vendor.crossorigin || (integrity ? 'anonymous' : '');
    if (crossorigin) script.setAttribute('crossorigin', crossorigin);
    script.src = src;

    const attempt = { cancelled: false, script, src };
    entry.attempt = attempt;
    entry.status = 'loading';
    script.addEventListener('load', () => handleLoad(entry, attempt));
    script.addEventListener('error', () => handleError(entry, attempt));
    log({ type: 'vendor-loading', id: vendor.id, src });
    (doc.head || doc.documentElement).appendChild(script);
  }

  function stopVendor(entry) {
    const { attempt, status } = entry;
    if (status === 'idle') return;
    // Update our own state first, so anything that runs below sees it.
    entry.status = 'idle';
    entry.attempt = null;
    entry.buffer.length = 0;
    if (attempt) {
      // A request that is already in flight cannot be recalled. The cancelled
      // flag makes the load handler run teardown if the script arrives later.
      attempt.cancelled = true;
      attempt.script.remove();
    }
    if (status === 'loaded') {
      runHook(entry.vendor, 'teardown', { env });
      log({ type: 'vendor-teardown', id: entry.vendor.id, late: false });
    }
    if (status !== 'failed') log({ type: 'vendor-removed', id: entry.vendor.id });
  }

  function dropQueue(reason) {
    for (const item of queue.splice(0)) log({ type: 'dropped', name: item.name, reason });
  }

  function flushQueue() {
    for (const item of queue.splice(0)) {
      deliver(finalize(item));
      log({ type: 'flushed', name: item.name });
    }
  }

  function applyState(next) {
    if (destroyed || next === state) return;
    state = next;
    log({ type: 'consent', state });

    if (state === 'granted') {
      saveAttribution(landing, attributionOptions);
      for (const entry of entries) startVendor(entry);
      flushQueue();
      return;
    }

    if (state === 'denied') clearAttribution(attributionOptions);
    for (const entry of entries) stopVendor(entry);
    if (state === 'denied') dropQueue('denied');
  }

  function track(name, props = {}) {
    if (typeof name !== 'string' || name === '') {
      throw new TypeError('track() needs an event name');
    }
    const item = { name, props: { ...props }, time: now() };

    if (destroyed || state === 'denied') {
      log({ type: 'dropped', name, reason: destroyed ? 'destroyed' : 'denied' });
      return 'dropped';
    }
    if (state === 'granted') {
      deliver(finalize(item));
      log({ type: 'sent', name });
      return 'sent';
    }
    queue.push(item);
    log({ type: 'queued', name });
    if (queue.length > maxQueue) {
      const oldest = queue.shift();
      log({ type: 'dropped', name: oldest.name, reason: 'queue-full' });
    }
    return 'queued';
  }

  function status() {
    return {
      state,
      env,
      queued: queue.length,
      vendors: Object.fromEntries(entries.map((entry) => [entry.vendor.id, entry.status])),
    };
  }

  function destroy() {
    if (destroyed) return;
    if (typeof unsubscribe === 'function') unsubscribe();
    for (const entry of entries) stopVendor(entry);
    dropQueue('destroyed');
    destroyed = true;
  }

  const unsubscribe = consent.subscribe(() => applyState(normalizeState(consent.getState())));
  applyState(normalizeState(consent.getState()));

  return {
    track,
    status,
    destroy,
    getAttribution: () => getAttribution(attributionOptions),
  };
}
