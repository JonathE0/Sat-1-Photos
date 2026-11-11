// Every page: the service worker that keeps the site's files until a publish changes them
// (site/sw.js). Registered once the page has loaded, so it never slows the first visit. Not
// on a local copy, where files change under it, unless the address asks for it with ?sw.
(() => {
  if (!('serviceWorker' in navigator) || !document.currentScript) return;
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  if (local && !new URLSearchParams(location.search).has('sw')) return;
  const root = new URL('../', document.currentScript.src);
  addEventListener('load', () => {
    navigator.serviceWorker.register(new URL('sw.js', root), { scope: root.pathname }).catch(() => {
      // not allowed here (a private window, a file:// copy): the browser's own cache as before
    });
  });
})();
