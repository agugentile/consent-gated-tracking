import {
  ENV_STORAGE_KEY,
  clearAttribution,
  createLoader,
  createMockAdapter,
} from '../src/index.js';

const $ = (id) => document.getElementById(id);

const consent = createMockAdapter('unknown');
const totals = { flushed: 0, dropped: 0 };
let loader = null;

const VENDORS = [
  { id: 'ad-pixel', label: 'Example ad pixel' },
  { id: 'analytics', label: 'Example analytics' },
];

// Each vendor loads the same harmless local script. The `vendor` query string
// only makes the two URLs differ, and the qa URL differs again.
const vendors = VENDORS.map(({ id }) => ({
  id,
  src: {
    prod: `./fake-vendor.js?vendor=${id}`,
    qa: `./fake-vendor.js?vendor=${id}&env=qa`,
  },
  onEvent(event) {
    const seen = Object.keys(event.attribution).length > 0 ? ' with attribution' : '';
    note(`${id} received "${event.name}"${seen}`, 'good');
    if (window.fakeVendors && window.fakeVendors[id]) {
      window.fakeVendors[id].track(event.name, event.props);
    }
  },
  teardown() {
    if (window.fakeVendors && window.fakeVendors[id]) {
      window.fakeVendors[id].stop();
      delete window.fakeVendors[id];
    }
  },
}));

// Log ---------------------------------------------------------------------------

const MAX_LOG_LINES = 150;

function note(text, tone = 'neutral', time = Date.now()) {
  const list = $('log');
  const empty = list.querySelector('.empty');
  if (empty) empty.remove();

  const item = document.createElement('li');
  item.dataset.tone = tone;
  const when = document.createElement('time');
  when.textContent = new Date(time).toLocaleTimeString([], { hour12: false });
  const what = document.createElement('span');
  what.textContent = text;
  item.append(when, what);

  list.prepend(item);
  while (list.children.length > MAX_LOG_LINES) list.lastElementChild.remove();
}

function describe(entry) {
  switch (entry.type) {
    case 'consent':
      return [`Consent is now ${entry.state}`, 'neutral'];
    case 'vendor-loading':
      return [`Adding the ${entry.id} script tag (${entry.src})`, 'neutral'];
    case 'vendor-loaded':
      return [`${entry.id} script loaded`, 'good'];
    case 'vendor-error':
      return [`${entry.id}: ${entry.reason}`, 'bad'];
    case 'vendor-teardown':
      return [
        `${entry.id} teardown ran${entry.late ? ' (the script arrived after the opt-out)' : ''}`,
        'bad',
      ];
    case 'vendor-removed':
      return [`${entry.id} script tag removed`, 'bad'];
    case 'queued':
      return [`Queued "${entry.name}" until consent is known`, 'warn'];
    case 'flushed':
      return [`Flushed "${entry.name}" to the vendors`, 'good'];
    case 'sent':
      return [`Sent "${entry.name}"`, 'good'];
    case 'dropped':
      return [`Dropped "${entry.name}" (${entry.reason})`, 'bad'];
    default:
      return [entry.type, 'neutral'];
  }
}

function onLog(entry) {
  if (entry.type === 'flushed') totals.flushed += 1;
  if (entry.type === 'dropped') totals.dropped += 1;
  const [text, tone] = describe(entry);
  note(text, tone, entry.time);
  render();
}

// Rendering -----------------------------------------------------------------------

function render() {
  if (!loader) return; // log entries arrive while the loader is still being created

  const status = loader.status();
  const loaded = Object.values(status.vendors).filter((value) => value === 'loaded').length;

  $('stat-loaded').textContent = String(loaded);
  $('stat-queued').textContent = String(status.queued);
  $('stat-flushed').textContent = String(totals.flushed);
  $('stat-dropped').textContent = String(totals.dropped);

  $('state').textContent = status.state;
  $('state').dataset.state = status.state;
  $('env').textContent = status.env;

  const list = $('vendors');
  list.replaceChildren();
  for (const { id, label } of VENDORS) {
    const item = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = label;
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.dataset.status = status.vendors[id];
    chip.textContent = status.vendors[id];
    item.append(name, chip);
    list.append(item);
  }

  const attribution = loader.getAttribution();
  $('attribution').textContent =
    Object.keys(attribution).length > 0
      ? JSON.stringify(attribution, null, 2)
      : 'Nothing stored yet. First-touch attribution is saved once consent is granted.';
}

// Wiring -----------------------------------------------------------------------------

loader = createLoader({ consent, vendors, onLog });
render();

$('accept').addEventListener('click', () => {
  note('You pressed Accept');
  consent.set('granted');
  render();
});
$('reject').addEventListener('click', () => {
  note('You pressed Reject');
  consent.set('denied');
  render();
});
$('opt-out').addEventListener('click', () => {
  note('You pressed Opt out (do not sell or share)');
  consent.set('denied');
  render();
});
$('reset').addEventListener('click', () => {
  note('You pressed Reset');
  consent.set('unknown');
  render();
});

for (const button of document.querySelectorAll('[data-track]')) {
  button.addEventListener('click', () => {
    loader.track(button.dataset.track, { page: 'demo' });
    render();
  });
}

$('forget').addEventListener('click', () => {
  clearAttribution();
  try {
    sessionStorage.removeItem(ENV_STORAGE_KEY);
  } catch {
    // Session storage may be blocked. Nothing else to clear.
  }
  window.location.assign(window.location.pathname);
});
