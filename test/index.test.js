import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage, createMockAdapter, init, track } from '../src/index.js';
import { createPage, finishLoading, recordingVendor, vendorScripts } from '../test-utils/dom.js';

function config(win, consent, vendor) {
  return {
    consent,
    vendors: [vendor],
    window: win,
    storage: createMemoryStorage(),
    sessionStorage: createMemoryStorage(),
  };
}

test('track() before init() says what is wrong', () => {
  assert.throws(() => track('too_early'), /Call init\(\) before track\(\)/);
});

test('init() creates the loader and track() uses it', () => {
  const win = createPage();
  const consent = createMockAdapter();
  const vendor = recordingVendor('ads');
  const loader = init(config(win, consent, vendor));

  assert.equal(track('hello'), 'queued');
  consent.grant();
  finishLoading(vendorScripts(win)[0]);
  assert.deepEqual(vendor.calls, ['onLoad', 'onEvent:hello']);

  loader.destroy();
});

test('calling init() again shuts the previous loader down', () => {
  const winA = createPage();
  const winB = createPage();
  const consentA = createMockAdapter('granted');
  const consentB = createMockAdapter();
  const vendorA = recordingVendor('ads');

  init(config(winA, consentA, vendorA));
  assert.equal(vendorScripts(winA).length, 1);

  const second = init(config(winB, consentB, recordingVendor('ads')));
  assert.equal(vendorScripts(winA).length, 0);
  assert.deepEqual(second.status().vendors, { ads: 'idle' });

  second.destroy();
});
