import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockAdapter, isConsentAdapter, normalizeState } from '../src/index.js';

test('the mock adapter starts unknown and reports changes', () => {
  const adapter = createMockAdapter();
  const seen = [];
  adapter.subscribe((state) => seen.push(state));

  assert.equal(adapter.getState(), 'unknown');
  adapter.grant();
  adapter.deny();
  adapter.reset();

  assert.deepEqual(seen, ['granted', 'denied', 'unknown']);
  assert.equal(adapter.getState(), 'unknown');
});

test('setting the same state again does not notify', () => {
  const adapter = createMockAdapter('granted');
  let calls = 0;
  adapter.subscribe(() => calls++);
  adapter.set('granted');
  assert.equal(calls, 0);
});

test('unsubscribe stops notifications', () => {
  const adapter = createMockAdapter();
  let calls = 0;
  const unsubscribe = adapter.subscribe(() => calls++);
  adapter.grant();
  unsubscribe();
  adapter.deny();
  assert.equal(calls, 1);
});

test('the mock adapter rejects unknown states', () => {
  assert.throws(() => createMockAdapter('maybe'), RangeError);
  assert.throws(() => createMockAdapter().set('yes'), RangeError);
  assert.throws(() => createMockAdapter().subscribe('nope'), TypeError);
});

test('normalizeState treats anything unrecognized as unknown', () => {
  assert.equal(normalizeState('granted'), 'granted');
  assert.equal(normalizeState('denied'), 'denied');
  assert.equal(normalizeState('GRANTED'), 'unknown');
  assert.equal(normalizeState(undefined), 'unknown');
  assert.equal(normalizeState(true), 'unknown');
});

test('isConsentAdapter checks for the two methods', () => {
  assert.equal(isConsentAdapter(createMockAdapter()), true);
  assert.equal(isConsentAdapter({ getState() {} }), false);
  assert.equal(isConsentAdapter(null), false);
});
