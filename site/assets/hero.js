// The gallery's opening screen: a starfield behind the title, one picture
// that stays put, and a reel of others that drift in from the side, hold
// for a few seconds while panning slowly, and leave the other way.
//
// The reel is timed by the progress bar's CSS animation: a slide advances
// when the bar fills. Pausing the bar (the Pause button, hovering the
// pictures, keyboard focus inside them) therefore pauses the reel too.
// With reduced motion the pictures still change, by a plain crossfade
// (see the end of style.css).

import { h } from './dom.js';
import { CAMERAS, toDate, dayMonthYear, clock, latLon } from './format.js';
import { detailTest } from './gallery.js';

const REEL_MAX = 12;
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

const pad2 = (n) => String(n).padStart(2, '0');

function when(p) {
  const d = toDate(p.capturedAt);
  if (d) return `${dayMonthYear(d)}, ${clock(d)} UTC`;
  const day = p.captureDate ? toDate(`${p.captureDate}T00:00:00Z`) : null;
  return day ? dayMonthYear(day) : 'Date unknown';
}

function where(p) {
  if (p.place || p.computedPlace) return p.place || p.computedPlace;
  return p.position ? latLon(p.position.lat, p.position.lon, 1) : '';
}

function altFor(p) {
  const camera = CAMERAS[p.camera]?.alt || 'Camera';
  const place = where(p);
  return `${camera} image${place ? ` over ${place}` : ''}, ${when(p)}`;
}

// The still picture is the one named in config.js (heroPicture), else the
// newest detailed frame; the next detailed frames make up the reel.
export function heroPicks(photos, stillId = '') {
  const detailed = photos.filter(detailTest(photos));
  const pool = detailed.length >= 2 ? detailed : photos.filter((p) => p.camera === 'picam');
  const still = photos.find((p) => p.id === stillId) || pool[0] || null;
  return { still, reel: pool.filter((p) => p !== still).slice(0, REEL_MAX) };
}

// Same stars on every visit: a small seeded generator (mulberry32).
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function drawStars(canvas) {
  const width = Math.round(canvas.clientWidth);
  const height = Math.round(canvas.clientHeight);
  if (!width || !height) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const rand = seeded(69015); // CTS-SAT-1's NORAD number
  const count = Math.round((width * height) / 2400);
  for (let i = 0; i < count; i++) {
    const x = rand() * width;
    const y = rand() * height;
    const r = rand() < 0.93 ? 0.3 + rand() * 0.45 : 0.8 + rand() * 0.55;
    const a = 0.2 + rand() * 0.65;
    ctx.fillStyle = rand() < 0.18 ? `rgba(176, 208, 255, ${a})` : `rgba(255, 255, 255, ${a})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

export function createHero(root, { stillId = '' } = {}) {
  const canvas = root.querySelector('.stars');
  const shots = root.querySelector('.hero-photos');
  const bar = root.querySelector('.reel-bar');

  let size = '';
  new ResizeObserver(() => {
    const next = `${canvas.clientWidth}x${canvas.clientHeight}`;
    if (next === size) return;
    size = next;
    drawStars(canvas);
  }).observe(canvas);

  root.querySelector('.down').addEventListener('click', () => {
    const main = document.getElementById('main');
    main.scrollIntoView({ behavior: reduceMotion.matches ? 'auto' : 'smooth' });
    main.focus({ preventScroll: true });
  });

  /* The still picture */

  const stillImg = h('img', { alt: '', decoding: 'async', fetchpriority: 'high' });
  const stillCap = h('span', { class: 'shot-cap' });
  const still = h('a', { class: 'hero-shot' }, stillImg, stillCap);

  /* The reel */

  const layers = [0, 1].map(() => h('img', { class: 'reel-img', alt: '', decoding: 'async' }));
  const reelCap = h('span', { class: 'shot-cap' });
  const reelLink = h('a', { class: 'hero-shot hero-reel' }, ...layers, reelCap);

  const indexEl = bar.querySelector('.reel-index');
  const totalEl = bar.querySelector('.reel-total');
  const fill = bar.querySelector('.reel-fill');
  const toggle = bar.querySelector('[data-toggle]');
  const next = bar.querySelector('[data-next]');

  let reel = [];
  let index = 0;
  let front = 0;
  let token = 0;
  let paused = false;

  function setPaused(value) {
    paused = value;
    root.classList.toggle('is-paused', paused);
    toggle.textContent = paused ? 'Play' : 'Pause';
    toggle.setAttribute('aria-label', paused ? 'Play the slideshow' : 'Pause the slideshow');
  }

  function restartFill() {
    fill.classList.remove('run');
    void fill.offsetWidth; // let the bar empty before it fills again
    fill.classList.add('run');
  }

  async function show(i, first = false) {
    if (!reel.length) return;
    index = (i + reel.length) % reel.length;
    const p = reel[index];
    const mine = ++token;
    const incoming = layers[1 - front];
    const outgoing = layers[front];
    incoming.dataset.state = 'enter';
    incoming.src = p.src;
    incoming.alt = altFor(p);
    try { await incoming.decode(); } catch { /* show it anyway */ }
    if (mine !== token) return; // a newer slide was asked for meanwhile
    void incoming.offsetWidth; // start from the "enter" position, off to the side
    incoming.dataset.state = 'shown';
    outgoing.dataset.state = first ? '' : 'leave';
    front = 1 - front;
    reelLink.href = `#/photo/${encodeURIComponent(p.id)}`;
    reelCap.textContent = [when(p), where(p)].filter(Boolean).join(' · ');
    indexEl.textContent = pad2(index + 1);
    restartFill();
  }

  fill.addEventListener('animationend', (e) => {
    if (e.target === fill && !paused) show(index + 1);
  });
  toggle.addEventListener('click', () => {
    setPaused(!paused);
    if (!paused && !fill.classList.contains('run')) restartFill();
  });
  next.addEventListener('click', () => show(index + 1));

  setPaused(paused);

  return {
    setData(photos) {
      const picks = heroPicks(photos, stillId);
      const ids = [picks.still, ...picks.reel].map((p) => p?.id).join(',');
      if (ids === root.dataset.picks) return; // same pictures: leave the reel where it is
      root.dataset.picks = ids;

      shots.replaceChildren();
      if (!picks.still) {
        bar.hidden = true;
        return;
      }
      stillImg.src = picks.still.src;
      stillImg.alt = altFor(picks.still);
      still.href = `#/photo/${encodeURIComponent(picks.still.id)}`;
      stillCap.textContent = [when(picks.still), where(picks.still)].filter(Boolean).join(' · ');
      shots.append(still);

      reel = picks.reel;
      shots.classList.toggle('is-single', reel.length === 0);
      bar.hidden = reel.length < 2;
      if (!reel.length) return;
      shots.append(reelLink);
      for (const layer of layers) layer.dataset.state = '';
      totalEl.textContent = pad2(reel.length);
      show(0, true);
    },
  };
}
