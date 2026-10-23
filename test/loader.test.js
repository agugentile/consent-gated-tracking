import test from 'node:test';
import assert from 'node:assert/strict';
import { createLoader, createMemoryStorage, createMockAdapter } from '../src/index.js';
import {
  createPage,
  failLoading,
  finishLoading,
  logCollector,
  recordingVendor,
  vendorScripts,
} from '../test-utils/dom.js';

function setup({ url, state = 'unknown', vendors, ...rest } = {}) {
  const win = createPage(url);
  const consent = createMockAdapter(state);
  const logs = logCollector();
  const storage = createMemoryStorage();
  const sessionStorage = createMemoryStorage();
  const list = vendors || [recordingVendor('ads'), recordingVendor('stats')];
  const loader = createLoader({
    consent,
    vendors: list,
    window: win,
    storage,
    sessionStorage,
    onLog: logs.onLog,
    ...rest,
  });
  return { win, consent, loader, logs, storage, sessionStorage, vendors: list };
}

function loadAll(win) {
  for (const script of vendorScripts(win)) finishLoading(script);
}

// Nothing loads without consent ---------------------------------------------

test('nothing loads while consent is unknown', () => {
  const { win, loader, vendors } = setup();
  assert.equal(vendorScripts(win).length, 0);
  assert.deepEqual(loader.status().vendors, { ads: 'idle', stats: 'idle' });
  assert.equal(loader.status().state, 'unknown');
  assert.deepEqual(vendors[0].calls, []);
});

test('nothing loads while consent is denied', () => {
  const { win, loader } = setup({ state: 'denied' });
  assert.equal(vendorScripts(win).length, 0);
  assert.equal(loader.status().state, 'denied');
});

test('an adapter that returns something odd is treated as unknown', () => {
  const win = createPage();
  const adapter = { getState: () => 'yes please', subscribe: () => () => {} };
  const loader = createLoader({
    consent: adapter,
    vendors: [recordingVendor('ads')],
    window: win,
    storage: null,
    sessionStorage: null,
  });
  assert.equal(vendorScripts(win).length, 0);
  assert.equal(loader.status().state, 'unknown');
});

// Loading on grant -----------------------------------------------------------

test('vendor scripts are injected when consent is granted', () => {
  const { win, consent, loader, vendors } = setup();
  consent.grant();

  const scripts = vendorScripts(win);
  assert.equal(scripts.length, 2);
  assert.equal(scripts[0].getAttribute('src'), 'https://cdn.example.test/ads.js');
  assert.equal(scripts[0].getAttribute('data-consent-vendor'), 'ads');
  assert.equal(scripts[1].getAttribute('src'), 'https://cdn.example.test/stats.js');
  assert.deepEqual(loader.status().vendors, { ads: 'loading', stats: 'loading' });

  finishLoading(scripts[0]);
  assert.deepEqual(loader.status().vendors, { ads: 'loaded', stats: 'loading' });
  assert.deepEqual(vendors[0].calls, ['onLoad']);
});

test('vendors load right away when consent is already granted at start', () => {
  const { win, loader } = setup({ state: 'granted' });
  assert.equal(vendorScripts(win).length, 2);
  assert.equal(loader.status().state, 'granted');
});

test('a second grant notification does not inject scripts twice', () => {
  const { win, consent } = setup();
  consent.grant();
  consent.set('granted');
  assert.equal(vendorScripts(win).length, 2);
});

test('a vendor whose script is a plain string uses it in every environment', () => {
  const vendor = { id: 'plain', src: 'https://cdn.example.test/plain.js' };
  const { win, consent } = setup({ url: 'https://shop.example.test/?env=qa', vendors: [vendor] });
  consent.grant();
  assert.equal(vendorScripts(win)[0].getAttribute('src'), 'https://cdn.example.test/plain.js');
});

// Denial ----------------------------------------------------------------------

test('denial runs teardown, removes the script tags, and nothing reloads until granted again', () => {
  const { win, consent, loader, vendors } = setup();
  consent.grant();
  loadAll(win);
  assert.equal(vendorScripts(win).length, 2);

  consent.deny();
  assert.deepEqual(vendors[0].calls, ['onLoad', 'teardown']);
  assert.deepEqual(vendors[1].calls, ['onLoad', 'teardown']);
  assert.equal(vendorScripts(win).length, 0);
  assert.deepEqual(loader.status().vendors, { ads: 'idle', stats: 'idle' });

  // Still denied: tracking and other consent noise must not bring anything back.
  loader.track('signup');
  consent.set('denied');
  consent.reset();
  assert.equal(vendorScripts(win).length, 0);

  // Only a new grant loads vendors again, with fresh script tags.
  consent.grant();
  assert.equal(vendorScripts(win).length, 2);
  loadAll(win);
  assert.deepEqual(vendors[0].calls, ['onLoad', 'teardown', 'onLoad']);
});

test('a script that finishes loading after denial is torn down at once', () => {
  const { win, consent, loader, vendors } = setup();
  consent.grant();
  const [pending] = vendorScripts(win);

  consent.deny();
  assert.equal(vendorScripts(win).length, 0);
  assert.deepEqual(vendors[0].calls, []);

  finishLoading(pending);
  assert.deepEqual(vendors[0].calls, ['teardown']);
  assert.equal(loader.status().vendors.ads, 'idle');
});

test('consent going back to unknown after a grant also shuts vendors down', () => {
  const { win, consent, loader, vendors } = setup();
  consent.grant();
  loadAll(win);

  consent.reset();
  assert.deepEqual(vendors[0].calls, ['onLoad', 'teardown']);
  assert.equal(vendorScripts(win).length, 0);

  // Unknown is not a denial: events wait again, and flush on the next grant.
  assert.equal(loader.track('later'), 'queued');
  consent.grant();
  loadAll(win);
  assert.deepEqual(vendors[0].calls, ['onLoad', 'teardown', 'onLoad', 'onEvent:later']);
});

// Event queue ----------------------------------------------------------------

test('events are held while unknown and flushed with attribution once vendors have loaded', () => {
  const { win, consent, loader, logs, vendors } = setup({
    url: 'https://shop.example.test/?utm_source=newsletter&gclid=abc',
  });

  assert.equal(loader.track('view_pricing', { plan: 'pro' }), 'queued');
  assert.equal(loader.track('start_signup'), 'queued');
  assert.equal(loader.status().queued, 2);
  assert.deepEqual(vendors[0].calls, []);

  consent.grant();
  // Scripts are still downloading: nothing is delivered yet.
  assert.deepEqual(vendors[0].calls, []);
  assert.equal(loader.status().queued, 0);

  loadAll(win);
  assert.deepEqual(vendors[0].calls, ['onLoad', 'onEvent:view_pricing', 'onEvent:start_signup']);
  assert.deepEqual(vendors[1].calls, ['onLoad', 'onEvent:view_pricing', 'onEvent:start_signup']);

  const [first] = vendors[0].events;
  assert.equal(first.name, 'view_pricing');
  assert.deepEqual(first.props, { plan: 'pro' });
  assert.deepEqual(first.attribution, { utm_source: 'newsletter', gclid: 'abc' });
  assert.equal(typeof first.time, 'number');

  assert.equal(logs.types('queued').length, 2);
  assert.equal(logs.types('flushed').length, 2);
  assert.equal(logs.types('dropped').length, 0);
});

test('events tracked after the grant go straight to loaded vendors', () => {
  const { win, consent, loader, vendors } = setup();
  consent.grant();
  loadAll(win);

  assert.equal(loader.track('purchase', { value: 20 }), 'sent');
  assert.deepEqual(vendors[0].calls, ['onLoad', 'onEvent:purchase']);
});

test('props are copied when an event is tracked', () => {
  const { win, consent, loader, vendors } = setup();
  const props = { step: 1 };
  loader.track('wizard', props);
  props.step = 2;
  consent.grant();
  loadAll(win);
  assert.deepEqual(vendors[0].events[0].props, { step: 1 });
});

test('queued events are dropped when consent is denied, and stay dropped', () => {
  const { win, consent, loader, logs, vendors } = setup();
  loader.track('view_pricing');
  loader.track('start_signup');

  consent.deny();
  assert.equal(loader.status().queued, 0);
  const dropped = logs.types('dropped');
  assert.deepEqual(
    dropped.map((entry) => [entry.name, entry.reason]),
    [
      ['view_pricing', 'denied'],
      ['start_signup', 'denied'],
    ],
  );

  assert.equal(loader.track('another'), 'dropped');
  assert.equal(logs.types('dropped').length, 3);

  // A later grant must not resurrect them.
  consent.grant();
  loadAll(win);
  assert.deepEqual(vendors[0].calls, ['onLoad']);
});

test('the queue is capped and drops the oldest event first', () => {
  const { win, consent, loader, logs, vendors } = setup({ maxQueue: 2 });
  loader.track('a');
  loader.track('b');
  loader.track('c');
  assert.equal(loader.status().queued, 2);
  assert.deepEqual(
    logs.types('dropped').map((entry) => [entry.name, entry.reason]),
    [['a', 'queue-full']],
  );

  consent.grant();
  loadAll(win);
  assert.deepEqual(vendors[0].calls, ['onLoad', 'onEvent:b', 'onEvent:c']);
});

test('track() needs an event name', () => {
  const { loader } = setup();
  assert.throws(() => loader.track(''), TypeError);
  assert.throws(() => loader.track(undefined), TypeError);
});

// Attribution ------------------------------------------------------------------

test('attribution is not stored before consent, is stored on grant, and is cleared on denial', () => {
  const { consent, loader, storage } = setup({
    url: 'https://shop.example.test/?utm_source=google&utm_campaign=brand&gclid=xyz',
  });
  assert.equal(storage.getItem('cgt_attribution'), null);
  assert.deepEqual(loader.getAttribution(), {});

  consent.grant();
  assert.notEqual(storage.getItem('cgt_attribution'), null);
  assert.deepEqual(loader.getAttribution(), {
    utm_source: 'google',
    utm_campaign: 'brand',
    gclid: 'xyz',
  });

  consent.deny();
  assert.equal(storage.getItem('cgt_attribution'), null);
  assert.deepEqual(loader.getAttribution(), {});
});

test('first-touch attribution is kept across later visits', () => {
  const storage = createMemoryStorage();
  const visit = (url) => {
    const vendor = recordingVendor('ads');
    const page = setup({ url, state: 'granted', storage, vendors: [vendor] });
    loadAll(page.win);
    page.loader.track('page_view');
    return vendor.events[0].attribution;
  };

  const first = visit('https://shop.example.test/?utm_source=google&gclid=first');
  const second = visit('https://shop.example.test/pricing?utm_source=newsletter&utm_medium=email');
  const third = visit('https://shop.example.test/about');

  assert.deepEqual(first, { utm_source: 'google', gclid: 'first' });
  assert.deepEqual(second, { utm_source: 'google', gclid: 'first' });
  assert.deepEqual(third, { utm_source: 'google', gclid: 'first' });
});

test('the first touch expires after the TTL', () => {
  const storage = createMemoryStorage();
  let clock = 0;
  const day = 24 * 60 * 60 * 1000;
  const options = { storage, state: 'granted', now: () => clock, attribution: { ttlDays: 30 } };

  setup({ ...options, url: 'https://shop.example.test/?utm_source=old' });
  clock = 31 * day;
  const later = setup({ ...options, url: 'https://shop.example.test/?utm_source=new' });
  assert.deepEqual(later.loader.getAttribution(), { utm_source: 'new' });
});

test('localStorage and sessionStorage of the page are used when none are passed in', () => {
  const win = createPage('https://shop.example.test/?utm_source=google&env=qa');
  const consent = createMockAdapter('granted');
  createLoader({ consent, vendors: [recordingVendor('ads')], window: win });

  assert.match(win.localStorage.getItem('cgt_attribution'), /google/);
  assert.equal(win.sessionStorage.getItem('cgt_env'), 'qa');
});

// Environments ------------------------------------------------------------------

test('prod is the default environment', () => {
  const { win, consent, loader } = setup();
  consent.grant();
  assert.equal(loader.status().env, 'prod');
  assert.equal(vendorScripts(win)[0].getAttribute('src'), 'https://cdn.example.test/ads.js');
});

test('?env=qa picks the qa script and is remembered for the session', () => {
  const sessionStorage = createMemoryStorage();

  const first = setup({ url: 'https://shop.example.test/?env=qa', sessionStorage });
  first.consent.grant();
  assert.equal(first.loader.status().env, 'qa');
  assert.equal(vendorScripts(first.win)[0].getAttribute('src'), 'https://cdn.example.test/ads.qa.js');
  assert.equal(sessionStorage.getItem('cgt_env'), 'qa');

  // A later page in the same session has no ?env= and still uses qa.
  const next = setup({ url: 'https://shop.example.test/pricing', sessionStorage });
  next.consent.grant();
  assert.equal(next.loader.status().env, 'qa');
  assert.equal(vendorScripts(next.win)[0].getAttribute('src'), 'https://cdn.example.test/ads.qa.js');
});

test('?env=prod switches back, and unknown values are ignored', () => {
  const sessionStorage = createMemoryStorage({ cgt_env: 'qa' });

  const ignored = setup({ url: 'https://shop.example.test/?env=staging', sessionStorage });
  assert.equal(ignored.loader.status().env, 'qa');

  const back = setup({ url: 'https://shop.example.test/?env=prod', sessionStorage });
  assert.equal(back.loader.status().env, 'prod');
  assert.equal(sessionStorage.getItem('cgt_env'), 'prod');
});

test('the env option sets the default, and allowEnvSwitch: false locks it', () => {
  const sessionStorage = createMemoryStorage();

  const qaDefault = setup({ env: 'qa', sessionStorage });
  assert.equal(qaDefault.loader.status().env, 'qa');

  const locked = setup({
    url: 'https://shop.example.test/?env=qa',
    allowEnvSwitch: false,
    sessionStorage,
  });
  assert.equal(locked.loader.status().env, 'prod');
  assert.equal(sessionStorage.getItem('cgt_env'), null);
});

test('a vendor with no src for the current environment is skipped and reported', () => {
  const vendor = { id: 'prod-only', src: { prod: 'https://cdn.example.test/p.js' } };
  const { win, consent, loader, logs } = setup({
    url: 'https://shop.example.test/?env=qa',
    vendors: [vendor, recordingVendor('stats')],
  });
  consent.grant();

  assert.equal(vendorScripts(win).length, 1);
  assert.equal(loader.status().vendors['prod-only'], 'failed');
  assert.match(logs.types('vendor-error')[0].reason, /no src for env "qa"/);
});

// Subresource integrity ------------------------------------------------------------

test('integrity and crossorigin are set when a vendor has a hash', () => {
  const vendor = recordingVendor('ads', { integrity: 'sha384-abc123' });
  const { win, consent } = setup({ vendors: [vendor] });
  consent.grant();

  const [script] = vendorScripts(win);
  assert.equal(script.getAttribute('integrity'), 'sha384-abc123');
  assert.equal(script.getAttribute('crossorigin'), 'anonymous');
});

test('integrity can differ per environment, and crossorigin can be overridden', () => {
  const vendor = recordingVendor('ads', {
    integrity: { prod: 'sha384-prod', qa: 'sha384-qa' },
    crossorigin: 'use-credentials',
  });

  const prod = setup({ vendors: [vendor] });
  prod.consent.grant();
  const [prodScript] = vendorScripts(prod.win);
  assert.equal(prodScript.getAttribute('integrity'), 'sha384-prod');
  assert.equal(prodScript.getAttribute('crossorigin'), 'use-credentials');

  const qa = setup({ url: 'https://shop.example.test/?env=qa', vendors: [vendor] });
  qa.consent.grant();
  assert.equal(vendorScripts(qa.win)[0].getAttribute('integrity'), 'sha384-qa');
});

test('no integrity or crossorigin attributes are added when a vendor has no hash', () => {
  const { win, consent } = setup({ vendors: [recordingVendor('ads')] });
  consent.grant();

  const [script] = vendorScripts(win);
  assert.equal(script.hasAttribute('integrity'), false);
  assert.equal(script.hasAttribute('crossorigin'), false);
});

// Opt-out after grant ------------------------------------------------------------------

test('opting out after a grant stops everything', () => {
  const { win, consent, loader, logs, storage, vendors } = setup({
    url: 'https://shop.example.test/?utm_source=google',
  });
  consent.grant();
  loadAll(win);
  loader.track('purchase');
  const deliveredBefore = vendors.map((vendor) => vendor.events.length);

  consent.deny();

  // Scripts gone, teardown ran once each, nothing waiting, identifiers cleared.
  assert.equal(vendorScripts(win).length, 0);
  assert.equal(vendors[0].calls.filter((call) => call === 'teardown').length, 1);
  assert.equal(vendors[1].calls.filter((call) => call === 'teardown').length, 1);
  assert.deepEqual(loader.status(), {
    state: 'denied',
    env: 'prod',
    queued: 0,
    vendors: { ads: 'idle', stats: 'idle' },
  });
  assert.equal(storage.getItem('cgt_attribution'), null);

  // Anything tracked afterwards goes nowhere.
  assert.equal(loader.track('after_opt_out'), 'dropped');
  assert.deepEqual(
    vendors.map((vendor) => vendor.events.length),
    deliveredBefore,
  );
  assert.equal(logs.types('dropped').at(-1).name, 'after_opt_out');
});

// Failure handling ------------------------------------------------------------------------

test('a script that fails to load is removed and reported, and other vendors carry on', () => {
  const { win, consent, loader, logs, vendors } = setup();
  consent.grant();
  loader.track('during_load');

  const [broken, healthy] = vendorScripts(win);
  failLoading(broken);
  finishLoading(healthy);

  assert.deepEqual(loader.status().vendors, { ads: 'failed', stats: 'loaded' });
  assert.equal(vendorScripts(win).length, 1);
  assert.deepEqual(vendors[0].calls, []);
  assert.deepEqual(vendors[1].calls, ['onLoad', 'onEvent:during_load']);
  assert.equal(logs.types('vendor-error').length, 1);

  // A failed vendor is retried on the next grant, not before.
  consent.deny();
  consent.grant();
  assert.equal(vendorScripts(win).length, 2);
});

test('a vendor hook that throws does not stop the others', () => {
  const noisy = recordingVendor('ads', {
    teardown() {
      throw new Error('boom');
    },
  });
  const quiet = recordingVendor('stats');
  const { win, consent, logs } = setup({ vendors: [noisy, quiet] });
  consent.grant();
  loadAll(win);

  consent.deny();
  assert.equal(vendorScripts(win).length, 0);
  assert.deepEqual(quiet.calls, ['onLoad', 'teardown']);
  assert.match(logs.types('vendor-error')[0].reason, /teardown threw: boom/);
});

test('a log handler that throws does not break the loader', () => {
  const { win, consent } = setup({
    onLog() {
      throw new Error('log failure');
    },
  });
  assert.doesNotThrow(() => consent.grant());
  assert.equal(vendorScripts(win).length, 2);
});

test('status() already reflects a change by the time its log entry is emitted', () => {
  let loader = null;
  const seen = [];
  const win = createPage();
  const consent = createMockAdapter();
  loader = createLoader({
    consent,
    vendors: [recordingVendor('ads'), recordingVendor('stats')],
    window: win,
    storage: createMemoryStorage(),
    sessionStorage: createMemoryStorage(),
    onLog(entry) {
      if (!loader) return; // entries emitted while the loader is still being created
      if (entry.type === 'vendor-removed') seen.push(loader.status().vendors[entry.id]);
      if (entry.type === 'consent') seen.push(loader.status().state === entry.state);
    },
  });

  consent.grant();
  loadAll(win);
  consent.deny();

  assert.ok(seen.length >= 4);
  assert.ok(seen.every((value) => value === 'idle' || value === true));
});

// Housekeeping --------------------------------------------------------------------------------

test('destroy() removes scripts, stops listening, and drops later events', () => {
  const { win, consent, loader, vendors } = setup();
  consent.grant();
  loadAll(win);

  loader.destroy();
  assert.equal(vendorScripts(win).length, 0);
  assert.deepEqual(vendors[0].calls, ['onLoad', 'teardown']);

  consent.deny();
  consent.grant();
  assert.equal(vendorScripts(win).length, 0);
  assert.equal(loader.track('late'), 'dropped');
});

test('bad configuration is rejected with a clear error', () => {
  const win = createPage();
  const consent = createMockAdapter();
  const base = { consent, window: win, storage: null, sessionStorage: null };
  const ok = { id: 'a', src: 'https://cdn.example.test/a.js' };

  assert.throws(() => createLoader({ ...base, consent: {}, vendors: [ok] }), /consent must be/);
  assert.throws(() => createLoader({ ...base, vendors: 'nope' }), /vendors must be an array/);
  assert.throws(() => createLoader({ ...base, vendors: [{ src: 'x' }] }), /needs a string id/);
  assert.throws(() => createLoader({ ...base, vendors: [{ id: 'a' }] }), /needs a src/);
  assert.throws(() => createLoader({ ...base, vendors: [ok, ok] }), /Duplicate vendor id: a/);
  assert.throws(() => createLoader({ ...base, vendors: [ok], env: 'staging' }), RangeError);
  assert.throws(() => createLoader({ consent, vendors: [ok], window: null }), /needs a browser window/);
});
