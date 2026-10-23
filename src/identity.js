// First-touch campaign attribution: UTM parameters and ad click ids.
//
// The first visit that carries any of these parameters is stored and kept for
// a fixed time (30 days by default). Later visits do not overwrite it. After
// the time is up, the next visit that carries parameters starts a new record.

import { read, write, remove, storageFrom } from './storage.js';

export const UTM_KEYS = Object.freeze([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
]);

export const CLICK_ID_KEYS = Object.freeze(['gclid', 'fbclid', 'ttclid', 'msclkid']);

export const DEFAULT_STORAGE_KEY = 'cgt_attribution';
export const DEFAULT_TTL_DAYS = 30;

const TRACKED_KEYS = [...UTM_KEYS, ...CLICK_ID_KEYS];
const MAX_VALUE_LENGTH = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

function settings(options = {}) {
  return {
    // `storage: null` means "do not persist"; leaving it out means localStorage.
    storage: options.storage === undefined ? storageFrom(globalThis, 'localStorage') : options.storage,
    key: options.key || DEFAULT_STORAGE_KEY,
    ttlMs: (options.ttlDays ?? DEFAULT_TTL_DAYS) * DAY_MS,
    now: options.now || Date.now,
  };
}

function pickTracked(source) {
  const picked = {};
  if (!source || typeof source !== 'object') return picked;
  for (const key of TRACKED_KEYS) {
    const value = source[key];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim().slice(0, MAX_VALUE_LENGTH);
    if (trimmed) picked[key] = trimmed;
  }
  return picked;
}

/**
 * Read UTM parameters and click ids from a URL string.
 * Returns only the parameters that are present and non-empty.
 */
export function parseAttribution(url) {
  let params;
  try {
    params = new URL(String(url), 'http://placeholder.invalid').searchParams;
  } catch {
    return {};
  }
  const found = {};
  for (const key of TRACKED_KEYS) {
    const value = params.get(key);
    if (value !== null) found[key] = value;
  }
  return pickTracked(found);
}

function readRecord(s) {
  const raw = read(s.storage, s.key);
  if (!raw) return null;
  try {
    const record = JSON.parse(raw);
    const valid =
      record &&
      typeof record === 'object' &&
      record.params &&
      typeof record.params === 'object' &&
      Number.isFinite(record.capturedAt);
    if (!valid) throw new Error('bad record');
    if (s.now() - record.capturedAt >= s.ttlMs) throw new Error('expired');
    return { params: pickTracked(record.params), capturedAt: record.capturedAt };
  } catch {
    remove(s.storage, s.key);
    return null;
  }
}

/** The stored first-touch attribution, or an empty object when there is none. */
export function getAttribution(options) {
  const record = readRecord(settings(options));
  return record ? { ...record.params } : {};
}

/**
 * Store `params` as the first touch, unless a valid first touch already exists.
 * Returns the attribution that is in effect after the call.
 */
export function saveAttribution(params, options) {
  const s = settings(options);
  const existing = readRecord(s);
  if (existing) return { ...existing.params };
  const clean = pickTracked(params);
  if (Object.keys(clean).length === 0) return {};
  write(s.storage, s.key, JSON.stringify({ params: clean, capturedAt: s.now() }));
  return clean;
}

/** Parse a URL and store what it carries as the first touch (if none exists yet). */
export function captureAttribution(url, options) {
  return saveAttribution(parseAttribution(url), options);
}

/** Remove the stored attribution. */
export function clearAttribution(options) {
  const s = settings(options);
  remove(s.storage, s.key);
}
