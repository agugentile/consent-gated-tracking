// A harmless stand-in for a third-party script. It only writes to the console
// and registers a tiny object on window, the way a real tag would.
(function () {
  const script = document.currentScript;
  const id = (script && script.getAttribute('data-consent-vendor')) || 'unknown';

  window.fakeVendors = window.fakeVendors || {};
  window.fakeVendors[id] = {
    track(name, props) {
      console.log('[fake vendor ' + id + '] event', name, props);
    },
    stop() {
      console.log('[fake vendor ' + id + '] stopped');
    },
  };

  console.log('[fake vendor ' + id + '] script loaded from', script && script.src);
})();
