/**
 * The satellite's pictures, one at a time, in a thin camera viewfinder: the sky
 * at the top right of the story's end view, on big screens.
 *
 *   createViewfinder(container, { photos, siteRoot, photoHref, onOpen, reducedMotion })
 *     -> { setPhotos(photos), start(), stop(), dispose() }
 *
 * `photos` is mergeAll() output; dark and mostly missing pictures are left out,
 * as in the catalogue's default view, and the rest run newest first and loop.
 *
 * Each picture comes down the way the real one did: top first, in packet-sized
 * bands at uneven intervals, with a faint line at the leading edge. Between
 * pictures the frame's contents fade to black while the brackets stay. The
 * corner data comes in once the picture has finished arriving. With reduced
 * motion the picture appears whole, by a plain crossfade.
 *
 * The rotation pauses while the viewfinder is hovered or focused, and while the
 * tab is hidden. Screen readers hear a picture only when the visitor steps to it
 * with Previous or Next.
 *
 * Styles: viewfinder.css (its sizes come from .jy-vf-slot in journey.css). Class
 * prefix `vf-`.
 */
import {
  calgaryTime,
  fmtLat,
  fmtLon,
  inDefaultSet,
  photoTime,
  placeOf,
  rowsWithData,
  statusLine,
  utcLong,
  utcShort,
} from './journey-parts.js';

const DWELL_MS = 12000; // each picture, start to start
const FIRST_MS = 4500; // the facts banner changes every 9 s or so: start half a beat after it
const SHUTTER_MS = 160; // keep in step with .is-shut in viewfinder.css
const BAND_PX = 16; // one row of the camera's JPEG blocks
const REVEAL_MS = 1200; // about, before the slower packets
const SCANLINE = 'rgba(230, 235, 240, 0.4)';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** Lines stacked in one corner. */
function setLines(node, lines) {
  node.replaceChildren(...lines.map((line) => el('span', null, line)));
}

/** The four corners: when, where, how high, the light on the ground. */
function cornerData(p) {
  const ms = p.capturedAt ? Date.parse(p.capturedAt) : NaN;
  let when;
  if (Number.isFinite(ms)) {
    const calgary = calgaryTime(ms);
    when = [utcLong(ms), `${calgary.time} ${calgary.zone} in Calgary`];
  } else {
    when = p.captureDate ? [photoTime(p), 'Time not known'] : ['Date not known'];
  }
  // a member's corrected time leaves the computed point behind; a corrected point keeps no light
  const stale = p.edited?.captured_at && !p.edited?.position;
  const pos = !stale && p.position && Number.isFinite(p.position.lat) && Number.isFinite(p.position.lon)
    ? p.position : null;
  const elevation = pos && !p.edited?.position ? pos.sun_elevation_deg : null;
  let sun = '';
  if (Number.isFinite(elevation)) sun = elevation >= 0 ? `Sun ${Math.round(elevation)}° up` : 'Night below';
  return {
    when,
    where: pos ? [fmtLat(pos.lat), fmtLon(pos.lon)] : [],
    height: pos && Number.isFinite(pos.alt_km) ? `${Math.round(pos.alt_km)} km up` : '',
    sun,
  };
}

/** "Came down 30 Oct, 04:48–04:54 UTC in 161 packets", or '' with nothing to say. */
function downlinkLine(p) {
  const dl = p.raw?.downlink;
  if (!dl || typeof dl !== 'object') return '';
  const first = Date.parse(dl.first);
  const last = Date.parse(dl.last);
  let range = '';
  if (Number.isFinite(first) && Number.isFinite(last)) {
    const [day0, time0] = utcShort(first).replace(' UTC', '').split(', ');
    const [day1, time1] = utcShort(last).replace(' UTC', '').split(', ');
    if (day0 !== day1) range = `${day0}, ${time0} to ${day1}, ${time1} UTC`;
    else if (time0 !== time1) range = `${day0}, ${time0}–${time1} UTC`;
    else range = `${day0}, ${time0} UTC`;
  }
  const n = dl.packets;
  const packets = Number.isFinite(n) ? `${n.toLocaleString('en-US')} ${n === 1 ? 'packet' : 'packets'}` : '';
  if (range && packets) return `Came down ${range} in ${packets}`;
  if (range) return `Came down ${range}`;
  return packets ? `Came down in ${packets}` : '';
}

/** What the caption owes the visitor about a picture that isn't whole, or ''. */
function honestNote(p) {
  return p.status === 'partial' || p.status === 'truncated' ? statusLine(p) : '';
}

const nameOf = (p) => placeOf(p) || photoTime(p) || p.title || 'A picture';

function loadImage(photo, siteRoot) {
  const img = new Image();
  img.decoding = 'async';
  img.src = new URL(photo.src || photo.thumb, siteRoot).href;
  return img.decode().then(() => img, () => null);
}

/**
 * The viewfinder. `container` gets one child; dispose() removes it.
 */
export function createViewfinder(container, {
  photos,
  siteRoot = document.baseURI,
  photoHref = (id) => `#/photo/${encodeURIComponent(id)}`,
  onOpen,
  reducedMotion = false,
} = {}) {
  const reduced = Boolean(reducedMotion);

  // ---- markup ----
  const root = el('div', 'vf');
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'Pictures from CTS-SAT-1');
  if (reduced) root.classList.add('vf-calm');

  const frameEl = el('div', 'vf-frame');
  for (const corner of ['tl', 'tr', 'bl', 'br']) {
    const bracket = el('span', `vf-bracket vf-bracket-${corner}`);
    bracket.setAttribute('aria-hidden', 'true');
    frameEl.append(bracket);
  }

  const whenEl = el('p', 'vf-corner vf-fades');
  const whereEl = el('p', 'vf-corner vf-corner-right vf-fades');
  const dataTop = el('div', 'vf-data vf-data-top');
  dataTop.append(whenEl, whereEl);

  // the link and the buttons stay put through every change, so focus is never lost
  const link = el('a', 'vf-pic');
  const canvas = el('canvas', 'vf-canvas');
  canvas.setAttribute('aria-hidden', 'true');
  const ctx = canvas.getContext('2d');
  const cross = el('span', 'vf-cross');
  cross.setAttribute('aria-hidden', 'true');
  link.append(canvas, cross);

  const heightEl = el('p', 'vf-corner vf-fades');
  const sunEl = el('p', 'vf-corner vf-corner-right vf-fades');
  const dataBottom = el('div', 'vf-data vf-data-bottom');
  dataBottom.append(heightEl, sunEl);
  frameEl.append(dataTop, link, dataBottom);

  const caption = el('div', 'vf-caption');
  const placeEl = el('p', 'vf-place vf-words');
  const downEl = el('p', 'vf-down vf-words');
  const noteEl = el('p', 'vf-note vf-words');

  const nav = el('div', 'vf-nav');
  const prevBtn = el('button', 'vf-btn', 'Previous');
  prevBtn.type = 'button';
  prevBtn.setAttribute('aria-label', 'Previous picture');
  const nextBtn = el('button', 'vf-btn', 'Next picture');
  nextBtn.type = 'button';
  nav.append(prevBtn, nextBtn);
  caption.append(placeEl, nav, downEl, noteEl);

  // announces only what the visitor steps to
  const announcer = el('p', 'vf-sr');
  announcer.setAttribute('aria-live', 'polite');
  announcer.setAttribute('aria-atomic', 'true');

  root.append(frameEl, caption, announcer);
  if (container) container.appendChild(root);

  // ---- state ----
  let deck = [];
  let index = -1;
  let shown = null; // the picture on screen
  let run = 0; // the latest step; an older one that was still loading gives way
  let misses = 0; // pictures in a row that wouldn't load
  let running = false;
  let hovered = false;
  let focused = false;
  let disposed = false;
  let timer = 0;
  let swapTimer = 0;
  let announceTimer = 0;
  let next = null; // { id, ready }, the next picture fetched ahead of time
  let band = null; // the reveal under way: { img, timer }

  const fetchPicture = (photo) => (next && next.id === photo.id ? next.ready : loadImage(photo, siteRoot));

  function fetchAhead() {
    if (deck.length < 2) return;
    const photo = deck[(index + 1) % deck.length];
    if (!next || next.id !== photo.id) next = { id: photo.id, ready: loadImage(photo, siteRoot) };
  }

  /** The picture has finished arriving: the corner data comes in. */
  function settled() {
    root.classList.add('is-settled');
    fetchAhead();
  }

  // the rows to draw (rowsWithData); below them the frame stays black
  let drawRows = 0;

  function drawWhole(img) {
    ctx.drawImage(img, 0, 0, img.naturalWidth, drawRows, 0, 0, img.naturalWidth, drawRows);
    settled();
  }

  function finishReveal() {
    if (!band) return;
    clearTimeout(band.timer);
    const { img } = band;
    band = null;
    drawWhole(img);
  }

  function dropReveal() {
    if (!band) return;
    clearTimeout(band.timer);
    band = null;
  }

  /** Top first, band by band, at uneven intervals; the next band paints over the scanline. */
  function reveal(img) {
    const w = canvas.width;
    const h = drawRows;
    const gap = REVEAL_MS / Math.ceil(canvas.height / BAND_PX);
    let y = 0;
    const packet = () => {
      const rows = Math.min(BAND_PX, h - y);
      ctx.drawImage(img, 0, y, w, rows, 0, y, w, rows);
      y += rows;
      if (y >= h) {
        band = null;
        settled();
        return;
      }
      ctx.fillStyle = SCANLINE;
      ctx.fillRect(0, y, w, 1);
      // now and then a packet is slower than the rest
      const wait = gap * (0.4 + Math.random() * 1.2) * (Math.random() < 0.06 ? 3 : 1);
      band.timer = setTimeout(packet, wait);
    };
    band = { img, timer: 0 };
    packet();
  }

  function paint(photo, img) {
    shown = photo;
    root.classList.add('has-picture');
    root.dataset.photoId = photo.id;

    const name = nameOf(photo);
    const time = photoTime(photo);
    link.href = photoHref(photo.id);
    link.setAttribute('aria-label', `Open the picture: ${name}${time && time !== name ? `, ${time}` : ''}`);

    const data = cornerData(photo);
    setLines(whenEl, data.when);
    setLines(whereEl, data.where);
    heightEl.textContent = data.height;
    sunEl.textContent = data.sun;
    placeEl.textContent = name;
    downEl.textContent = downlinkLine(photo);
    noteEl.textContent = honestNote(photo);

    // setting the size clears the canvas to the frame's black
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    drawRows = rowsWithData(img, photo);
    root.classList.remove('is-shut', 'is-settled');
    if (reduced || !running || document.hidden) drawWhole(img);
    else reveal(img);
  }

  function announce(photo) {
    const time = photoTime(photo);
    const parts = [nameOf(photo), time && time !== nameOf(photo) ? time : '', downlinkLine(photo), honestNote(photo)];
    announcer.textContent = '';
    clearTimeout(announceTimer);
    // a fresh node text makes the same sentence announce again
    announceTimer = setTimeout(() => {
      if (!disposed) announcer.textContent = parts.filter(Boolean).join('. ');
    }, 50);
  }

  /** Step through the deck: the next picture is ready before the shutter closes on this one. */
  function step(dir, manual) {
    if (disposed || !deck.length) return;
    index = (index + dir + deck.length) % deck.length;
    const photo = deck[index];
    const mine = ++run;
    clearTimeout(timer);
    timer = 0;
    fetchPicture(photo).then((img) => {
      if (disposed || mine !== run) return;
      if (!img) {
        // skip one that won't load; if none will, the frame keeps what it has, or goes
        if (++misses < deck.length) {
          step(dir, manual);
        } else {
          root.classList.remove('is-shut');
          root.hidden = !shown;
        }
        return;
      }
      misses = 0;
      next = null;
      const swap = () => {
        if (disposed || mine !== run) return;
        paint(photo, img);
        schedule();
        if (manual) announce(photo);
      };
      clearTimeout(swapTimer);
      dropReveal();
      if (shown) {
        root.classList.add('is-shut');
        swapTimer = setTimeout(swap, SHUTTER_MS);
      } else {
        swap();
      }
    });
  }

  function schedule() {
    clearTimeout(timer);
    timer = 0;
    if (!running || disposed || !deck.length || document.hidden) return;
    if (shown && (hovered || focused)) return;
    timer = setTimeout(() => step(1, false), shown ? DWELL_MS : FIRST_MS);
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
  const onVisibility = () => {
    if (document.hidden) finishReveal();
    schedule();
  };
  const onClick = (e) => {
    if (!shown || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (typeof onOpen !== 'function') return;
    e.preventDefault();
    onOpen(shown.id);
  };

  prevBtn.addEventListener('click', onPrev);
  nextBtn.addEventListener('click', onNext);
  link.addEventListener('click', onClick);
  root.addEventListener('pointerenter', onEnter);
  root.addEventListener('pointerleave', onLeave);
  root.addEventListener('focusin', onFocusIn);
  root.addEventListener('focusout', onFocusOut);
  document.addEventListener('visibilitychange', onVisibility);

  function setPhotos(list) {
    const at = deck[index]?.id;
    deck = (Array.isArray(list) ? list : [])
      .filter(inDefaultSet)
      .sort((a, b) => (b.sortTime || 0) - (a.sortTime || 0));
    index = deck.findIndex((p) => p.id === at);
    next = null;
    misses = 0;
    root.hidden = false;
    nav.hidden = deck.length < 2;
    if (running && !timer) schedule();
  }

  setPhotos(photos);

  // ---- API ----
  return {
    setPhotos,
    /** Show pictures: the first after a moment, then one every 12 s. */
    start() {
      if (disposed || running) return;
      running = true;
      schedule();
    },
    /** Stop rotating; a picture still arriving finishes at once and stays. */
    stop() {
      running = false;
      clearTimeout(timer);
      timer = 0;
      finishReveal();
    },
    dispose() {
      disposed = true;
      running = false;
      clearTimeout(timer);
      clearTimeout(swapTimer);
      clearTimeout(announceTimer);
      dropReveal();
      prevBtn.removeEventListener('click', onPrev);
      nextBtn.removeEventListener('click', onNext);
      link.removeEventListener('click', onClick);
      root.removeEventListener('pointerenter', onEnter);
      root.removeEventListener('pointerleave', onLeave);
      root.removeEventListener('focusin', onFocusIn);
      root.removeEventListener('focusout', onFocusOut);
      document.removeEventListener('visibilitychange', onVisibility);
      root.remove();
    },
  };
}
