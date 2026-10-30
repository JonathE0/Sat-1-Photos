/**
 * A small rotating banner of facts about CTS-SAT-1, and the "In the news" list.
 *
 *   createFactTicker(container, { facts, live, intervalMs = 9000, reducedMotion })
 *     -> { start(), stop(), next(), prev(), dispose() }
 *   createNewsList(container, { news }) -> { dispose() }
 *
 * `facts` is the list in facts.json (objects with `text` and `sources`, or plain
 * strings). `live()` returns the satellite's numbers right now, or null:
 *   { speedKmS, altKm, latDeg, lonDeg, placeName?, orbitsSinceLaunch?, daysInOrbit?,
 *     pictures?, isLive? }
 * Any of them may be null; a live fact that needs a missing number is skipped.
 * Pass `isLive: false` when the clock is off live time and "right now" is dropped.
 *
 * One fact at a time, in a shuffled order with no repeats until all have been
 * shown. Each fact slides out to one side as it fades and the next slides in
 * from the other. The rotation pauses while the banner is hovered or focused,
 * and while the tab is hidden. Screen readers hear a fact only when the visitor
 * steps to it with Previous or Next. With reduced motion the facts still change,
 * by a plain crossfade with no slide.
 *
 * Styles: facts.css. Class prefix `cf-`.
 */

const FADE_IN_MS = 400;
const FADE_OUT_MS = 240; // exits run at 60% of the entrance
const LIVE_EVERY = 4; // every 4th fact is a live one, when live numbers are there
const LAUNCH_LABEL = '3 May 2026';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const fmtInt = (n) => Math.round(n).toLocaleString('en-US');

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** "2026-05-05" -> "5 May 2026"; anything else is returned as given. */
export function formatDate(iso) {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(String(iso || ''));
  if (!m) return iso ? String(iso) : '';
  const month = MONTHS[Number(m[2]) - 1];
  if (!month) return String(iso);
  return m[3] ? `${Number(m[3])} ${month} ${m[1]}` : `${month} ${m[1]}`;
}

function shuffle(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function prefersReducedMotion() {
  try {
    return matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** Facts from facts.json as { id, text, source } items. */
function staticItems(facts) {
  const out = [];
  (Array.isArray(facts) ? facts : []).forEach((f, i) => {
    if (typeof f === 'string') {
      if (f.trim()) out.push({ id: `fact-${i}`, kind: 'static', text: f.trim(), source: null });
      return;
    }
    if (!f || typeof f.text !== 'string' || !f.text.trim()) return;
    const s = Array.isArray(f.sources) ? f.sources.find((x) => x && typeof x.url === 'string') : null;
    out.push({
      id: f.id || `fact-${i}`,
      kind: 'static',
      text: f.text.trim(),
      source: s ? { outlet: s.outlet || s.title || 'Source', url: s.url, title: s.title || '' } : null,
    });
  });
  return out;
}

/** Live facts: each `make(r)` returns { text, note } or null when its numbers are missing. */
const LIVE = [
  {
    id: 'live-speed',
    make(r) {
      const v = num(r.speedKmS);
      if (v == null) return null;
      const kmh = Math.round((v * 3600) / 100) * 100;
      return {
        text: `It's moving at ${v.toFixed(2)} km/s${now(r)}, about ${fmtInt(kmh)} km/h.`,
        note: 'Worked out from its orbital elements',
      };
    },
  },
  {
    id: 'live-altitude',
    make(r) {
      const a = num(r.altKm);
      if (a == null) return null;
      return { text: `It's ${fmtInt(a)} km above the ground${now(r)}.`, note: 'Worked out from its orbital elements' };
    },
  },
  {
    id: 'live-place',
    make(r) {
      const lat = num(r.latDeg);
      const lon = num(r.lonDeg);
      const when = r.isLive === false ? 'At this moment' : 'Right now';
      if (typeof r.placeName === 'string' && r.placeName.trim()) {
        return { text: `${when} it's over ${r.placeName.trim()}.`, note: 'Worked out from its orbital elements' };
      }
      if (lat == null || lon == null) return null;
      const ns = `${Math.abs(lat).toFixed(1)}° ${lat >= 0 ? 'N' : 'S'}`;
      const ew = `${Math.abs(lon).toFixed(1)}° ${lon >= 0 ? 'E' : 'W'}`;
      return { text: `${when} it's above ${ns}, ${ew}.`, note: 'Worked out from its orbital elements' };
    },
  },
  {
    id: 'live-orbits',
    make(r) {
      const n = num(r.orbitsSinceLaunch);
      if (n == null || n < 1) return null;
      const days = num(r.daysInOrbit);
      const perDay = days && days > 1 ? n / days : null;
      return {
        text: perDay
          ? `It has gone round the Earth about ${fmtInt(n)} times since launch, roughly ${perDay.toFixed(1)} times a day.`
          : `It has gone round the Earth about ${fmtInt(n)} times since launch.`,
        note: 'Counted from its orbital elements',
      };
    },
  },
  {
    id: 'live-distance',
    make(r) {
      const n = num(r.orbitsSinceLaunch);
      const a = num(r.altKm);
      if (n == null || n < 10 || a == null) return null;
      // one lap is about the circumference at its height above a 6,371 km Earth
      const km = n * 2 * Math.PI * (6371 + a);
      const millions = km / 1e6;
      const shown = millions >= 10 ? fmtInt(millions) : millions.toFixed(1);
      return { text: `It has travelled about ${shown} million km since launch.`, note: 'Worked out from its orbit count and height' };
    },
  },
  {
    id: 'live-days',
    make(r) {
      const d = num(r.daysInOrbit);
      if (d == null || d < 1) return null;
      const whole = Math.floor(d);
      return {
        text: `It has been in orbit for ${fmtInt(whole)} ${whole === 1 ? 'day' : 'days'}, since ${LAUNCH_LABEL}.`,
        note: 'Counted from the launch date',
      };
    },
  },
  {
    id: 'live-pictures',
    make(r) {
      const p = num(r.pictures);
      if (p == null || p < 1) return null;
      return {
        text: p === 1
          ? 'So far 1 of its pictures has made it down to the ground.'
          : `So far ${fmtInt(p)} of its pictures have made it down to the ground.`,
        note: 'Counted from the pictures on this site',
      };
    },
  },
];

function now(r) {
  return r && r.isLive === false ? '' : ' right now';
}

/**
 * The banner. `container` gets one child; dispose() removes it.
 */
export function createFactTicker(container, { facts, live, intervalMs = 9000, reducedMotion } = {}) {
  const reduced = typeof reducedMotion === 'boolean' ? reducedMotion : prefersReducedMotion();
  const interval = Math.max(3000, Number(intervalMs) || 9000);
  const statics = staticItems(facts);
  const lives = typeof live === 'function' ? LIVE.map((l) => ({ id: l.id, kind: 'live', make: l.make })) : [];

  // ---- markup ----
  const root = el('div', 'cf');
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'Facts about CTS-SAT-1');
  if (reduced) root.classList.add('cf-calm'); // crossfade only, no slide

  // the fact and its source fade; the buttons stay put, so focus is never lost
  const text = el('p', 'cf-text cf-fades');
  const meta = el('p', 'cf-meta cf-fades');

  const nav = el('div', 'cf-nav');
  const prevBtn = el('button', 'cf-btn', 'Previous');
  prevBtn.type = 'button';
  const nextBtn = el('button', 'cf-btn', 'Next fact');
  nextBtn.type = 'button';
  nav.append(prevBtn, nextBtn);

  const foot = el('div', 'cf-foot');
  foot.append(meta, nav);

  // announces only what the visitor steps to
  const announcer = el('p', 'cf-sr');
  announcer.setAttribute('aria-live', 'polite');
  announcer.setAttribute('aria-atomic', 'true');

  root.append(text, foot, announcer);
  if (container) container.appendChild(root);

  // ---- state ----
  let staticDeck = [];
  let liveDeck = [];
  let sinceLive = LIVE_EVERY - 1; // the first fact is a live one when it can be
  const history = [];
  let pos = -1;
  let running = false;
  let timer = 0;
  let fadeTimer = 0;
  let refreshTimer = 0;
  let hovered = false;
  let focused = false;
  let disposed = false;
  let shownText = '';

  function readLive() {
    if (typeof live !== 'function') return null;
    try {
      const r = live();
      return r && typeof r === 'object' ? r : null;
    } catch {
      return null;
    }
  }

  /** Resolve an item to { text, source | note }, or null if it can't be shown now. */
  function resolve(item) {
    if (!item) return null;
    if (item.kind === 'static') return { text: item.text, source: item.source, note: null };
    const r = readLive();
    if (!r) return null;
    const out = item.make(r);
    return out ? { text: out.text, source: null, note: out.note } : null;
  }

  function drawFrom(deckName, all) {
    let deck = deckName === 'live' ? liveDeck : staticDeck;
    if (!deck.length) {
      if (!all.length) return null;
      deck = shuffle(all);
      // no immediate repeat across a reshuffle
      const last = history[history.length - 1];
      if (last && deck.length > 1 && deck[0].id === last.id) deck.push(deck.shift());
      if (deckName === 'live') liveDeck = deck;
      else staticDeck = deck;
    }
    return deck.shift();
  }

  /** The next new item, skipping live ones whose numbers aren't there. */
  function drawNew() {
    const wantLive = lives.length && (sinceLive >= LIVE_EVERY - 1 || !statics.length);
    if (wantLive) {
      for (let tries = 0; tries < lives.length; tries++) {
        const item = drawFrom('live', lives);
        if (item && resolve(item)) {
          sinceLive = 0;
          return item;
        }
      }
    }
    if (statics.length) {
      sinceLive++;
      return drawFrom('static', statics);
    }
    return null;
  }

  function paint(item) {
    const r = resolve(item);
    if (!r) return false;
    shownText = r.text;
    text.textContent = r.text;
    meta.textContent = '';
    if (r.source && r.source.url) {
      meta.append('Source: ');
      const a = el('a', 'cf-link', r.source.outlet);
      a.href = r.source.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      if (r.source.title) a.title = r.source.title;
      a.append(el('span', 'cf-sr', ' (opens in a new tab)'));
      meta.append(a);
    } else if (r.note) {
      meta.textContent = r.note;
    }
    root.dataset.factId = item.id;
    // aria-disabled rather than disabled: a focused button keeps its focus
    prevBtn.setAttribute('aria-disabled', String(pos <= 0));
    return true;
  }

  /** Keep a live fact's numbers current while it is on screen (no movement, no announcement). */
  function scheduleRefresh() {
    clearInterval(refreshTimer);
    const item = history[pos];
    if (!item || item.kind !== 'live' || disposed) return;
    refreshTimer = setInterval(() => {
      const r = resolve(history[pos]);
      if (r && r.text !== shownText) {
        shownText = r.text;
        text.textContent = r.text;
      }
    }, 1000);
  }

  function announce(item) {
    const r = resolve(item);
    if (!r) return;
    const src = r.source ? ` Source: ${r.source.outlet}.` : '';
    announcer.textContent = '';
    // a fresh node text makes the same sentence announce again
    setTimeout(() => {
      if (!disposed) announcer.textContent = `${r.text}${src}`;
    }, 50);
  }

  /**
   * Show history[pos] with a slide and fade: the old fact leaves to one side
   * and the new one comes in from the other (dir 1: leaves left, enters from
   * the right; dir -1: the reverse). With reduced motion, the CSS drops the
   * slide and keeps the fade.
   */
  function show({ manual = false, dir = 1 } = {}) {
    const item = history[pos];
    if (!item) return;
    clearTimeout(fadeTimer);
    root.classList.toggle('is-back', dir < 0);
    const animate = Boolean(shownText);
    const swap = () => {
      if (disposed) return;
      if (!paint(item)) return;
      if (animate) {
        // jump to the entry side with no transition, then let it slide home
        root.classList.add('is-enter');
        root.classList.remove('is-out');
        void root.offsetWidth;
        root.classList.remove('is-enter');
      } else {
        root.classList.remove('is-out');
      }
      scheduleRefresh();
      if (manual) announce(item);
    };
    if (animate) {
      root.classList.add('is-out');
      fadeTimer = setTimeout(swap, FADE_OUT_MS);
    } else {
      swap();
    }
  }

  function step(dir, manual) {
    if (disposed) return;
    if (dir < 0) {
      if (pos <= 0) return;
      pos--;
    } else if (pos < history.length - 1) {
      pos++;
    } else {
      // try a few draws: a live fact may have lost its numbers since it was dealt
      let item = null;
      for (let i = 0; i < 4 && !item; i++) {
        const next = drawNew();
        if (!next) break;
        if (resolve(next)) item = next;
      }
      if (!item) return;
      history.push(item);
      if (history.length > 200) history.shift();
      pos = history.length - 1;
    }
    show({ manual, dir });
    schedule();
  }

  function paused() {
    return hovered || focused || (typeof document !== 'undefined' && document.hidden);
  }

  function schedule() {
    clearTimeout(timer);
    timer = 0;
    if (!running || disposed || paused()) return;
    timer = setTimeout(() => step(1, false), interval + FADE_IN_MS);
  }

  // ---- events ----
  const onPrev = () => step(-1, true);
  const onNext = () => step(1, true);
  const onEnter = () => {
    hovered = true;
    schedule();
  };
  const onLeave = () => {
    hovered = false;
    schedule();
  };
  const onFocusIn = (e) => {
    // keyboard focus pauses; a mouse click on a button doesn't hold the rotation forever
    let visible = true;
    try {
      visible = e.target.matches(':focus-visible');
    } catch { /* older browsers: treat as keyboard focus */ }
    focused = visible;
    schedule();
  };
  const onFocusOut = (e) => {
    if (e.relatedTarget && root.contains(e.relatedTarget)) return;
    focused = false;
    schedule();
  };
  const onVisibility = () => schedule();

  prevBtn.addEventListener('click', onPrev);
  nextBtn.addEventListener('click', onNext);
  root.addEventListener('pointerenter', onEnter);
  root.addEventListener('pointerleave', onLeave);
  root.addEventListener('focusin', onFocusIn);
  root.addEventListener('focusout', onFocusOut);
  document.addEventListener('visibilitychange', onVisibility);

  // ---- API ----
  return {
    /** Show a fact (if none yet) and rotate. */
    start() {
      if (disposed) return;
      running = true;
      if (pos < 0) step(1, false);
      else {
        scheduleRefresh();
        schedule();
      }
    },
    /** Stop rotating; the current fact stays. */
    stop() {
      running = false;
      clearTimeout(timer);
      clearInterval(refreshTimer);
      timer = 0;
    },
    /** Step to the next fact, as the Next button does (announced). */
    next() {
      step(1, true);
    },
    /** Step back, as the Previous button does (announced). */
    prev() {
      step(-1, true);
    },
    dispose() {
      disposed = true;
      running = false;
      clearTimeout(timer);
      clearTimeout(fadeTimer);
      clearInterval(refreshTimer);
      prevBtn.removeEventListener('click', onPrev);
      nextBtn.removeEventListener('click', onNext);
      root.removeEventListener('pointerenter', onEnter);
      root.removeEventListener('pointerleave', onLeave);
      root.removeEventListener('focusin', onFocusIn);
      root.removeEventListener('focusout', onFocusOut);
      document.removeEventListener('visibilitychange', onVisibility);
      root.remove();
    },
    /** For tests: the id of the fact on screen. */
    get currentId() {
      return history[pos] ? history[pos].id : null;
    },
    element: root,
  };
}

/**
 * "In the news": newest first, outlet and date under each title, links open in
 * a new tab. Shows the newest few and a button for the rest.
 */
export function createNewsList(container, { news, initial = 6, heading = 'In the news' } = {}) {
  const items = (Array.isArray(news) ? news : [])
    .filter((n) => n && typeof n.url === 'string' && typeof n.title === 'string')
    .map((n, i) => ({ ...n, _i: i }))
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || a._i - b._i);

  const root = el('section', 'cf-news');
  if (!items.length) {
    // nothing to list: leave the slot empty so it collapses
    return { dispose() {}, element: null };
  }
  const headId = `cf-news-${Math.random().toString(36).slice(2, 8)}`;
  root.setAttribute('aria-labelledby', headId);
  const h = el('h3', 'cf-news-title', heading);
  h.id = headId;
  const list = el('ul', 'cf-news-list');

  const kindWord = (n) => {
    if (n.kind === 'video') return 'video';
    if (n.kind === 'podcast' && !/podcast/i.test(n.outlet || '')) return 'podcast';
    return '';
  };

  items.forEach((n, i) => {
    const li = el('li', 'cf-news-item');
    if (i >= initial) li.hidden = true;
    const a = el('a', 'cf-link cf-news-link', n.title);
    a.href = n.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.append(el('span', 'cf-sr', ' (opens in a new tab)'));
    const parts = [n.outlet, kindWord(n), formatDate(n.date)].filter(Boolean);
    const meta = el('span', 'cf-news-meta', parts.join(', '));
    li.append(a, meta);
    list.append(li);
  });

  root.append(h, list);

  let toggle = null;
  let open = false;
  const onToggle = () => {
    open = !open;
    [...list.children].forEach((li, i) => {
      li.hidden = !open && i >= initial;
    });
    toggle.textContent = open ? 'Show fewer' : `Show all ${items.length}`;
    toggle.setAttribute('aria-expanded', String(open));
    if (!open) toggle.scrollIntoView?.({ block: 'nearest' });
  };
  if (items.length > initial) {
    toggle = el('button', 'cf-textbtn', `Show all ${items.length}`);
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.addEventListener('click', onToggle);
    root.append(toggle);
  }

  if (container) container.appendChild(root);

  return {
    dispose() {
      toggle?.removeEventListener('click', onToggle);
      root.remove();
    },
    element: root,
  };
}
