/* After a deploy a browser can hold some of the site's old files, each for up to
   10 minutes (GitHub Pages' max-age), and fetch the rest new. New code meeting an old
   file then fails while the page is starting, and the page stays blank. So when
   that happens: fetch everything the page loaded past the cache, then reload. It tries
   once in those 10 minutes, so a real fault can't keep reloading the page. */
(function () {
  var KEY = 'cts-freshened';
  var ONCE_IN_MS = 10 * 60 * 1000;
  var STARTING_MS = 20 * 1000;
  var startedAt = Date.now();
  var busy = false;
  var gaveUp = false;

  // The fresh files didn't help (or there's no storage to stop it reloading for ever):
  // it doesn't reload again, and says so once, in a quiet line along the bottom of the screen.
  function giveUp() {
    if (gaveUp) return;
    gaveUp = true;
    console.warn('FrontierSat: the page failed while starting, and fetching its files fresh didn’t fix it. '
      + 'It won’t reload by itself again for 10 minutes.');
    var line = document.querySelector('.orbit-loading');
    if (line) {
      line.textContent = 'The globe couldn’t load. Try reloading the page in a few minutes.';
      return;
    }
    line = document.createElement('p');
    line.setAttribute('role', 'status');
    line.textContent = 'Part of this page couldn’t load. Try reloading it in a few minutes.';
    line.style.cssText = 'position:fixed;right:0;bottom:0;left:0;z-index:1000;margin:0;'
      + 'padding:8px 16px calc(8px + env(safe-area-inset-bottom, 0px));background:#10151B;color:#E6EBF0;font-size:14px;line-height:1.5';
    document.body.append(line);
  }

  addEventListener('error', function (event) {
    var err = event.error;
    if (busy || Date.now() - startedAt > STARTING_MS) return;
    if (!(err instanceof SyntaxError || err instanceof TypeError || err instanceof ReferenceError)) return;
    if (String(event.filename || '').indexOf(location.origin) !== 0) return;
    var last = 0;
    try {
      last = Number(sessionStorage.getItem(KEY)) || 0;
      if (Date.now() - last < ONCE_IN_MS) {
        giveUp();
        return;
      }
      sessionStorage.setItem(KEY, String(Date.now()));
    } catch (e) {
      giveUp(); // no storage: nothing to stop it reloading for ever
      return;
    }
    busy = true;
    var files = performance.getEntriesByType('resource')
      .map(function (entry) { return entry.name; })
      .filter(function (url) { return url.indexOf(location.origin) === 0 && /\.(js|css)(\?|$)/.test(url); });
    Promise.all(files.map(function (url) {
      return fetch(url, { cache: 'reload' }).catch(function () {});
    })).then(function () { location.reload(); });
  });
})();
