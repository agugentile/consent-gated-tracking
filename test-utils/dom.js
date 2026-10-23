import { JSDOM } from 'jsdom';

/**
 * A fresh page. jsdom does not fetch or run external scripts by default, so
 * injected vendor scripts just sit in the DOM until a test fires their events.
 */
export function createPage(url = 'https://shop.example.test/') {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url });
  return dom.window;
}

/** Vendor script tags currently in the page, optionally for one vendor id. */
export function vendorScripts(win, id) {
  const selector = id
    ? `script[data-consent-vendor="${id}"]`
    : 'script[data-consent-vendor]';
  return [...win.document.querySelectorAll(selector)];
}

/** Pretend the browser finished downloading and running a script. */
export function finishLoading(script) {
  script.dispatchEvent(new script.ownerDocument.defaultView.Event('load'));
}

/** Pretend the download failed. */
export function failLoading(script) {
  script.dispatchEvent(new script.ownerDocument.defaultView.Event('error'));
}

/**
 * A vendor that records what the loader does to it.
 * `calls` is a flat list such as ['onLoad', 'onEvent:signup', 'teardown'].
 */
export function recordingVendor(id, extra = {}) {
  const calls = [];
  const events = [];
  return {
    id,
    src: {
      prod: `https://cdn.example.test/${id}.js`,
      qa: `https://cdn.example.test/${id}.qa.js`,
    },
    onLoad: () => calls.push('onLoad'),
    onEvent: (event) => {
      calls.push(`onEvent:${event.name}`);
      events.push(event);
    },
    teardown: () => calls.push('teardown'),
    calls,
    events,
    ...extra,
  };
}

/** Collects the loader's log entries so tests can look at them. */
export function logCollector() {
  const entries = [];
  const onLog = (entry) => entries.push(entry);
  const types = (type) => entries.filter((entry) => entry.type === type);
  return { entries, onLog, types };
}
