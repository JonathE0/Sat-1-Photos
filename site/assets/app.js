// CTS-SAT-1 picture gallery: data loading, hash routes and the shared chrome.
//   #/              explore: the scroll story and the live satellite (site/explore/)
//   #/pictures      the catalogue (filters and selection in the query: #/pictures?id=…&camera=picam)
//   #/photo/<id>    one picture, with every detail and the edit form
//   #/about         what the site shows and where it comes from

import { h, append, mono, announce, store } from './dom.js';
import { loadImages, loadAnnotations, mergeAll, readFilters, applyFilters } from './data.js';
import { createCatalogue } from './catalogue.js';
import { createDetail, NAME_KEY } from './detail.js';
import { mountJourney } from '../explore/journey.js';
import { toDate, utcLong, plural } from './format.js';

const config = { repoUrl: '', ...(window.CTS1_CONFIG || {}) };

const state = {
  data: null,
  annotations: {},
  editable: false,
  server: false,
  photos: [],
  byId: new Map(),
  loaded: false,
  view: null,
  galleryQuery: '',
  lastPhotoId: null,
  fromGallery: false,
  picturesFromExplore: false, // the catalogue was opened from the globe: its Back returns there
  pendingFocus: null,
  navigated: false, // false until the first in-page navigation; focus stays put on a fresh load
  hash: '', // the route being shown, to undo a navigation the member declines
  skipGuard: false, // set by goToPhoto/closeDetail after their own confirm
};

const $ = (selector) => document.querySelector(selector);

const views = {
  explore: $('#view-explore'),
  pictures: $('#view-pictures'),
  detail: $('#view-detail'),
  about: $('#view-about'),
};

if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

const SITE = new URL('./', location.href);

// The globe is the front page, but the pictures must not depend on it: if it
// can't start, the rest of the site still works and Explore says so.
const journey = startJourney();

function startJourney() {
  try {
    return mountJourney($('#journey'), {
      tleUrl: new URL('data/tle.json', SITE).href,
      siteRoot: SITE.href,
      photoHref: (id) => `#/pictures?id=${encodeURIComponent(id)}&from=globe`,
      catalogueHref: '#/pictures?from=globe',
      // ?motion=full or ?motion=reduced overrides prefers-reduced-motion (for testing)
      motion: new URLSearchParams(location.search).get('motion'),
      onOpenPhoto(id) { location.hash = `#/pictures?id=${encodeURIComponent(id)}&from=globe`; },
      onOpenCatalogue() { location.hash = '#/pictures?from=globe'; },
    });
  } catch (err) {
    console.error('Explore: the globe could not start', err);
    $('#journey').replaceChildren(h('p', { class: 'notice' },
      "The globe couldn't start in this browser. ",
      h('a', { class: 'text-link', href: '#/pictures' }, 'See the pictures')));
    const noop = () => {};
    return { hide: noop, show: noop, setPhotos: noop, openCredits: noop, closeCredits: noop };
  }
}

const gallery = createCatalogue(views.pictures, {
  onQueryChange(query) { state.galleryQuery = query; },
  onBack: backToExplore,
});

const detail = createDetail(views.detail, {
  config,
  getPhoto: (id) => state.byId.get(id),
  getList: navList,
  editable: () => state.editable,
  readOnlyServer: () => state.server && !state.editable,
  satellite: () => state.data?.satellite || null,
  backHref: galleryHref,
  close: closeDetail,
  go: goToPhoto,
  onName: setNameLabel,
  async onSaved(id, record) {
    if (record) {
      state.annotations = { ...state.annotations, [id]: record };
    } else {
      const fresh = await loadAnnotations();
      if (fresh.server) state.annotations = fresh.annotations;
    }
    rebuild();
  },
});

/* Navigation helpers */

function galleryHref() {
  return state.galleryQuery ? `#/pictures?${state.galleryQuery}` : '#/pictures';
}

// "Back to the globe" in the catalogue: the globe is still as it was (it is
// only hidden), so going back in history returns to it exactly.
function backToExplore() {
  if (state.picturesFromExplore && history.length > 1) history.back();
  else location.hash = '#/';
}

// Prev/next follow the gallery as last filtered, or every picture when the
// photo is not in that view (for example, a shared link).
function navList(id) {
  let list = applyFilters(state.photos, readFilters(new URLSearchParams(state.galleryQuery)));
  let index = list.findIndex((p) => p.id === id);
  if (index < 0) {
    list = state.photos;
    index = list.findIndex((p) => p.id === id);
  }
  return { list, index };
}

function confirmLeave() {
  if (state.view === 'detail' && detail.isDirty()) {
    return window.confirm('Leave this picture without saving your changes?');
  }
  return true;
}

// Prev/next replace the history entry, so Back returns to the grid (or to
// the globe the picture was opened from: its ?globe= state stays on).
function goToPhoto(id, via) {
  if (!confirmLeave()) return;
  state.skipGuard = true; // already asked
  state.pendingFocus = via || null; // "prev", "next" or "key": where focus goes on the new picture
  const qi = location.hash.indexOf('?');
  location.replace(`#/photo/${encodeURIComponent(id)}${qi >= 0 ? location.hash.slice(qi) : ''}`);
}

function closeDetail() {
  if (!confirmLeave()) return;
  state.skipGuard = true; // already asked
  if (state.fromGallery && history.length > 1) history.back();
  else location.hash = galleryHref();
}

/* Router */

function parseRoute() {
  const raw = location.hash.replace(/^#/, '');
  const qi = raw.indexOf('?');
  const path = qi >= 0 ? raw.slice(0, qi) : raw;
  const query = qi >= 0 ? raw.slice(qi + 1) : '';
  // #/?credits=1 (from the Orbit page's Credits link) opens the globe with its
  // credits panel; an old gallery link with filters (#/?camera=picam) opens
  // the catalogue.
  if (path === '' || path === '/') {
    if (new URLSearchParams(query).get('credits') === '1') return { view: 'explore', credits: true };
    return query ? { view: 'pictures', query } : { view: 'explore' };
  }
  if (path === '/pictures' || path === '/pictures/') return { view: 'pictures', query };
  const photo = /^\/photo\/([^/]+)\/?$/.exec(path);
  if (photo) {
    let id = photo[1];
    try { id = decodeURIComponent(id); } catch { /* keep it as it is */ }
    return { view: 'detail', id };
  }
  if (path === '/about') return { view: 'about' };
  return { view: 'explore' };
}

function setView(view) {
  state.view = view;
  document.body.dataset.view = view;
  for (const [name, el] of Object.entries(views)) el.hidden = name !== view;
  for (const link of document.querySelectorAll('[data-nav]')) {
    if (link.dataset.nav === view) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

function route() {
  state.hash = location.hash;
  const next = parseRoute();
  const previous = state.view;
  // The globe keeps its camera, time, scroll and lock while hidden; hide it
  // before anything else scrolls the page.
  if (previous === 'explore' && next.view !== 'explore') journey.hide();
  if (next.view === 'detail') {
    state.fromGallery = previous === 'pictures' || (previous === 'detail' && state.fromGallery);
  }
  if (next.view === 'pictures' && previous !== 'pictures') {
    state.picturesFromExplore = previous === 'explore';
  }
  setView(next.view);

  if (next.view === 'explore') {
    document.title = 'CTS-SAT-1 · Interactive picture visualizer';
    if (next.credits) {
      state.creditsAfterRoute = true;
      history.replaceState(history.state, '', '#/');
    }
    if (previous !== 'explore') journey.show();
    if (state.creditsAfterRoute) {
      state.creditsAfterRoute = false;
      journey.openCredits($('#credits'));
    }
    return;
  }

  if (next.view === 'pictures') {
    state.galleryQuery = next.query;
    document.title = 'Pictures · CTS-SAT-1';
    if (previous !== 'pictures') window.scrollTo(0, 0);
    gallery.show(new URLSearchParams(next.query));
    if (previous === 'detail' && state.lastPhotoId) gallery.focusTile(state.lastPhotoId);
    return;
  }

  if (next.view === 'detail') {
    const focus = state.pendingFocus || (state.navigated ? 'title' : null);
    state.pendingFocus = null;
    state.lastPhotoId = next.id;
    if (!state.loaded) {
      document.title = 'CTS-SAT-1';
      views.detail.replaceChildren(h('p', { class: 'notice', role: 'status' }, 'Loading the picture…'));
      return;
    }
    if (window.scrollY > 0) window.scrollTo(0, 0);
    detail.show(next.id, { focus });
    return;
  }

  document.title = 'About · CTS-SAT-1';
  if (previous !== 'about') window.scrollTo(0, 0);
  if (state.navigated && previous !== 'about') views.about.querySelector('.about-title')?.focus({ preventScroll: true });
}

/* Data */

function rebuild() {
  state.photos = mergeAll(state.data.images, state.annotations);
  state.byId = new Map(state.photos.map((p) => [p.id, p]));
  gallery.setData(state.photos);
  journey.setPhotos(state.photos);
  updateCounts();
  renderSkipped();
}

// Image files known from the satellite that can't be shown, listed on the
// About page with the reason (images.json "skipped").
function renderSkipped() {
  const box = $('#about-skipped');
  if (!box) return;
  const list = (Array.isArray(state.data?.skipped) ? state.data.skipped : [])
    .filter((s) => s && typeof s.file === 'string' && s.file);
  box.hidden = list.length === 0;
  box.querySelector('ul').replaceChildren(
    ...list.map((s) => h('li', null, mono(s.file), typeof s.reason === 'string' && s.reason ? `: ${s.reason}.` : '')),
  );
}

function updateCounts() {
  const built = toDate(state.data?.generated_at);
  const updated = $('#foot-updated');
  updated.replaceChildren();
  append(updated, [
    built ? ['Picture list last changed ', mono(utcLong(built, false)), '. '] : '',
    // An empty schedule: a copy that is updated by hand makes no promise.
    refreshText() ? `It is rebuilt ${refreshText()} from the pipeline, which reprocesses SatNOGS observations about every 15 minutes.` : '',
  ]);
}

// "twice a day, at …" from config.js; older configs give refreshMinutes instead.
function refreshText() {
  if (typeof config.refreshSchedule === 'string') return config.refreshSchedule.trim();
  const minutes = Number(config.refreshMinutes);
  return Number.isFinite(minutes) && minutes > 0 ? `every ${plural(minutes, 'minute')}` : '';
}

function loadErrorMessage(error) {
  if (error && error.kind === 'missing') {
    return [
      "The picture list hasn't been built yet. Run ",
      h('code', null, 'python -m cts1_gallery update'),
      ' to create data/images.json; this page checks again every 30 seconds.',
    ];
  }
  return ["Couldn't load the picture list (data/images.json). Reload the page to try again."];
}

let retryTimer = 0;

async function loadData() {
  const [images, annotations] = await Promise.allSettled([loadImages(), loadAnnotations()]);
  if (annotations.status === 'fulfilled') {
    state.annotations = annotations.value.annotations;
    state.editable = annotations.value.editable;
    state.server = annotations.value.server;
  }
  if (images.status === 'rejected') {
    const message = loadErrorMessage(images.reason);
    gallery.showError(message);
    if (state.view === 'detail') views.detail.replaceChildren(h('p', { class: 'notice' }, ...message));
    if (images.reason?.kind === 'missing') {
      window.clearTimeout(retryTimer);
      retryTimer = window.setTimeout(loadData, 30000);
    }
    return;
  }
  state.data = images.value;
  state.loaded = true;
  $('.name-ctl').hidden = !state.editable;
  rebuild();
  route();
}

/* "Your name" in the nav, used for edits */

function setNameLabel(name = store.get(NAME_KEY)) {
  const button = $('.name-btn');
  button.textContent = name || 'Your name';
  button.classList.toggle('is-set', Boolean(name));
  button.setAttribute('aria-label', name ? `Your name for edits: ${name}. Change it` : 'Set your name for edits');
  detail.setName(name);
}

function setupNameControl() {
  const button = $('.name-btn');
  const form = $('#name-form');
  const input = $('#name-input');

  const open = () => {
    form.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    input.value = store.get(NAME_KEY);
    input.focus();
    input.select();
  };
  const close = (returnFocus = true) => {
    if (form.hidden) return;
    form.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (returnFocus) button.focus();
  };

  button.addEventListener('click', () => (form.hidden ? open() : close()));
  form.querySelector('[data-cancel]').addEventListener('click', () => close());
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = input.value.trim().replace(/\s+/g, ' ');
    store.set(NAME_KEY, name);
    setNameLabel(name);
    close();
    announce(name ? `Your name is set to ${name}.` : 'Your name is cleared.');
  });
  document.addEventListener('click', (e) => {
    if (!form.hidden && !e.target.closest('.name-ctl')) close(false);
  });
  setNameLabel();
}

/* Credits: a panel over the globe, reachable from every page */

function setupCredits() {
  const button = $('#credits');
  button.addEventListener('click', () => {
    if (button.getAttribute('aria-expanded') === 'true') {
      journey.closeCredits();
      return;
    }
    if (state.view === 'explore') {
      journey.openCredits(button);
    } else {
      state.creditsAfterRoute = true; // route() opens it once the globe is shown
      location.hash = '#/';
    }
  });
}

/* Start */

document.querySelector('[data-skip]').addEventListener('click', (e) => {
  e.preventDefault();
  const target = state.view === 'detail' ? $('#detail-title') : $('#main');
  (target || $('#main')).focus();
});

document.addEventListener('keydown', (e) => {
  if (state.view === 'detail' && state.loaded) detail.handleKey(e);
});

window.addEventListener('hashchange', () => {
  const skip = state.skipGuard;
  state.skipGuard = false;
  // Nav links, Back, tag links: anything that leaves a picture with unsaved
  // edits asks first, like Previous/Next and "All pictures" do.
  if (!skip && parseRoute().id !== state.lastPhotoId && !confirmLeave()) {
    // Undo the change without a hashchange or a re-render, so the typed text stays.
    history.pushState(null, '', state.hash);
    return;
  }
  state.navigated = true;
  route();
});

// Reload, closing the tab, the globe and other pages.
window.addEventListener('beforeunload', (e) => {
  if (state.view === 'detail' && detail.isDirty()) {
    e.preventDefault();
    e.returnValue = '';
  }
});

setupNameControl();
setupCredits();
route();
loadData();
