/*
 * FrontierSat's service worker: a returning visitor downloads only what has changed.
 *
 * GitHub Pages gives every file a new date and ETag each time the site publishes (about
 * hourly), so the browser's own cache fetched everything again, the Earth's textures and
 * all. Each publish also writes files.json (cts1_gallery/files.py): every file's path and a
 * fingerprint of what's in it. A file is kept here under its fingerprint and served from
 * here while files.json still lists that fingerprint; when it changes, the new file is
 * fetched once and the old one dropped.
 *
 *   - Pages (a navigation) come from the network, and from here only when it's out of
 *     reach, so a TV that reloads while the Wi-Fi is down still shows the site.
 *   - What files.json doesn't list (data/*.json, anything asked for with ?, other sites)
 *     goes to the network as if this weren't here, and so does everything when there's no
 *     files.json (a local copy that hasn't run `python -m cts1_gallery files`).
 *   - What's kept is checked against its fingerprint first: a stale copy from a cache on the
 *     way is never kept under a new one.
 *
 * To take it out of service, publish an sw.js that unregisters itself; assets/sw-register.js
 * registers it on every page.
 */
const FILES = 'cts-files-1';
const PAGES = 'cts-pages-1';
const SCOPE = new URL(self.registration.scope);
const LIST_URL = new URL('files.json', SCOPE).href;
/** How long a list fetched for one page also serves the files asked for after it. */
const LIST_FRESH_MS = 10 * 60_000;

let list = null; // { path: fingerprint }
let listAt = 0;
let listing = null;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('cts-') && key !== FILES && key !== PAGES) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

/** files.json, fetched afresh for a page (fresh) or when the last one is old; null without one. */
function loadList(fresh) {
  if (!fresh && list && Date.now() - listAt < LIST_FRESH_MS) return Promise.resolve(list);
  listing ||= (async () => {
    try {
      const res = await fetch(LIST_URL, { cache: 'no-cache' });
      // none here (a local copy): everything from the network, as if this weren't here
      const body = res.ok ? await res.json().catch(() => null) : null;
      list = body && typeof body.files === 'object' ? body.files : null;
      listAt = Date.now();
    } catch {
      // offline: the last list, if this worker has one
    } finally {
      listing = null;
    }
    return list;
  })();
  return listing;
}

async function fingerprint(buffer) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
  return [...bytes.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const keyFor = (url, print) => `${url.origin}${url.pathname}?v=${print}`;

/** Keep a fetched file under its fingerprint if it's the one the list names, and drop its older copies. */
async function keep(url, print, response) {
  const buffer = await response.arrayBuffer();
  if ((await fingerprint(buffer)) !== print) return;
  const cache = await caches.open(FILES);
  await cache.put(keyFor(url, print), new Response(buffer, {
    status: 200,
    headers: { 'Content-Type': response.headers.get('Content-Type') || 'application/octet-stream' },
  }));
  for (const old of await cache.keys()) {
    const u = new URL(old.url);
    if (u.pathname === url.pathname && u.searchParams.get('v') !== print) await cache.delete(old);
  }
}

/** Once a page's list is in: drop what no longer matches it. */
async function prune(files) {
  if (!files) return;
  const cache = await caches.open(FILES);
  for (const old of await cache.keys()) {
    const u = new URL(old.url);
    if (files[pathOf(u)] !== u.searchParams.get('v')) await cache.delete(old);
  }
}

function pathOf(url) {
  try {
    return decodeURIComponent(url.pathname.slice(SCOPE.pathname.length));
  } catch {
    return '';
  }
}

async function file(event, url) {
  const files = await loadList(false);
  const print = files?.[pathOf(url)];
  const cache = await caches.open(FILES);
  if (print) {
    const kept = await cache.match(keyFor(url, print));
    if (kept) return kept;
  }
  try {
    if (!print) return await fetch(event.request);
    // past the browser's own copy, which may be the one before this publish
    const response = await fetch(url.href, { cache: 'no-cache', credentials: 'same-origin' });
    if (response.status === 200) event.waitUntil(keep(url, print, response.clone()).catch(() => {}));
    return response;
  } catch (err) {
    // out of reach: whatever copy of it is kept, however old
    const any = await cache.match(url.href, { ignoreSearch: true });
    if (any) return any;
    throw err;
  }
}

async function page(event) {
  event.waitUntil(loadList(true).then(prune).catch(() => {}));
  const url = new URL(event.request.url);
  const key = `${url.origin}${url.pathname}`;
  try {
    const response = await fetch(event.request);
    if (response.ok && response.type === 'basic') {
      const copy = response.clone();
      event.waitUntil(caches.open(PAGES).then((c) => c.put(key, copy)).catch(() => {}));
    }
    return response;
  } catch (err) {
    const kept = await (await caches.open(PAGES)).match(key);
    if (kept) return kept;
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== SCOPE.origin || !url.pathname.startsWith(SCOPE.pathname)) return;
  if (request.mode === 'navigate') {
    event.respondWith(page(event));
    return;
  }
  // asked for something particular (a query, a range, no cache at all): as if this weren't here
  if (url.search || request.headers.has('range') || request.cache === 'no-store' || request.cache === 'reload') return;
  event.respondWith(file(event, url));
});
