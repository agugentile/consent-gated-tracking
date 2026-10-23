import test from 'node:test';
import assert from 'node:assert/strict';
import {
  captureAttribution,
  clearAttribution,
  createMemoryStorage,
  getAttribution,
  parseAttribution,
  saveAttribution,
} from '../src/index.js';

const DAY = 24 * 60 * 60 * 1000;

test('parseAttribution reads UTM parameters and click ids', () => {
  const url =
    'https://shop.example.test/pricing?utm_source=newsletter&utm_medium=email' +
    '&utm_campaign=spring&utm_term=shoes&utm_content=hero&gclid=g1&fbclid=f1&ttclid=t1&msclkid=m1';
  assert.deepEqual(parseAttribution(url), {
    utm_source: 'newsletter',
    utm_medium: 'email',
    utm_campaign: 'spring',
    utm_term: 'shoes',
    utm_content: 'hero',
    gclid: 'g1',
    fbclid: 'f1',
    ttclid: 't1',
    msclkid: 'm1',
  });
});

test('parseAttribution ignores other parameters, blanks and bad input', () => {
  assert.deepEqual(parseAttribution('https://a.test/?page=2&utm_source=%20%20&gclid='), {});
  assert.deepEqual(parseAttribution('https://a.test/?utm_source=%20x%20'), { utm_source: 'x' });
  assert.deepEqual(parseAttribution('not a url at all'), {});
  assert.deepEqual(parseAttribution(undefined), {});
});

test('parseAttribution caps very long values', () => {
  const long = 'a'.repeat(500);
  const { utm_campaign } = parseAttribution(`https://a.test/?utm_campaign=${long}`);
  assert.equal(utm_campaign.length, 200);
});

test('the first touch is stored and later visits do not replace it', () => {
  const storage = createMemoryStorage();
  let clock = 1_000_000;
  const options = { storage, now: () => clock };

  captureAttribution('https://a.test/?utm_source=google&gclid=first', options);
  clock += 3 * DAY;
  const second = captureAttribution('https://a.test/?utm_source=newsletter&utm_campaign=later', options);

  assert.deepEqual(second, { utm_source: 'google', gclid: 'first' });
  assert.deepEqual(getAttribution(options), { utm_source: 'google', gclid: 'first' });
});

test('a visit without parameters stores nothing', () => {
  const storage = createMemoryStorage();
  assert.deepEqual(captureAttribution('https://a.test/about', { storage }), {});
  assert.deepEqual(getAttribution({ storage }), {});
  assert.equal(storage.getItem('cgt_attribution'), null);
});

test('the first touch expires after the TTL and the next touch starts a new one', () => {
  const storage = createMemoryStorage();
  let clock = 0;
  const options = { storage, now: () => clock, ttlDays: 30 };

  saveAttribution({ utm_source: 'old' }, options);
  clock = 29 * DAY;
  assert.deepEqual(getAttribution(options), { utm_source: 'old' });

  clock = 30 * DAY;
  assert.deepEqual(getAttribution(options), {});

  assert.deepEqual(saveAttribution({ utm_source: 'new' }, options), { utm_source: 'new' });
  assert.deepEqual(getAttribution(options), { utm_source: 'new' });
});

test('ttlDays can be changed', () => {
  const storage = createMemoryStorage();
  let clock = 0;
  const options = { storage, now: () => clock, ttlDays: 1 };
  saveAttribution({ gclid: 'x' }, options);
  clock = DAY + 1;
  assert.deepEqual(getAttribution(options), {});
});

test('clearAttribution removes the stored record', () => {
  const storage = createMemoryStorage();
  saveAttribution({ utm_source: 'x' }, { storage });
  clearAttribution({ storage });
  assert.deepEqual(getAttribution({ storage }), {});
});

test('a corrupt stored record is ignored and replaced', () => {
  const storage = createMemoryStorage({ cgt_attribution: '{not json' });
  assert.deepEqual(getAttribution({ storage }), {});
  assert.deepEqual(saveAttribution({ utm_source: 'x' }, { storage }), { utm_source: 'x' });
  assert.deepEqual(getAttribution({ storage }), { utm_source: 'x' });
});

test('storage that throws never breaks capture', () => {
  const broken = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    },
    removeItem() {
      throw new Error('blocked');
    },
  };
  const result = captureAttribution('https://a.test/?utm_source=x', { storage: broken });
  assert.deepEqual(result, { utm_source: 'x' });
  assert.deepEqual(getAttribution({ storage: broken }), {});
  assert.doesNotThrow(() => clearAttribution({ storage: broken }));
});

test('storage: null means nothing is persisted', () => {
  assert.deepEqual(captureAttribution('https://a.test/?gclid=x', { storage: null }), { gclid: 'x' });
  assert.deepEqual(getAttribution({ storage: null }), {});
});
