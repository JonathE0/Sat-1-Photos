// Tiny DOM helpers. Text always goes in as text nodes, never as HTML,
// so titles and notes typed by members cannot inject markup.

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value == null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'value') el.value = value;
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') {
        el.addEventListener(key.slice(2), value);
      } else el.setAttribute(key, value === true ? '' : String(value));
    }
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const child of [children].flat(Infinity)) {
    if (child == null || child === false || child === '') continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

// Joins nodes or strings with a separator, skipping empty ones.
export function joined(items, sep = ' · ') {
  const out = [];
  for (const item of items) {
    if (item == null || item === false || item === '') continue;
    if (out.length) out.push(sep);
    out.push(item);
  }
  return out;
}

export function mono(text) {
  return h('span', { class: 'mono' }, text);
}

export function announce(text) {
  const el = document.getElementById('announce');
  if (!el) return;
  el.textContent = '';
  // A fresh write after clearing makes screen readers repeat identical messages.
  window.setTimeout(() => { el.textContent = text; }, 30);
}

export const store = {
  get(key) {
    try { return window.localStorage.getItem(key) || ''; } catch { return ''; }
  },
  set(key, value) {
    try {
      if (value) window.localStorage.setItem(key, value);
      else window.localStorage.removeItem(key);
    } catch { /* storage can be blocked; the value is just not remembered */ }
  },
};

export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the old way */ }
  const area = h('textarea', { class: 'vh', readonly: true, 'aria-hidden': 'true' });
  area.value = text;
  document.body.append(area);
  area.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  area.remove();
  return ok;
}

// A quick sideways swipe with one finger on el: fn(1) for a swipe to the left (on to the next,
// as a page turns), fn(-1) for one to the right. Up and down still scroll; a page pinched in
// pans instead; and a swipe from the screen's edge is left to the browser's own Back.
export function onSwipe(el, fn) {
  const EDGE = 24;
  let start = null;
  el.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    const zoomed = (window.visualViewport?.scale || 1) > 1.01;
    const atEdge = t.clientX < EDGE || t.clientX > window.innerWidth - EDGE;
    start = e.touches.length === 1 && !zoomed && !atEdge ? { x: t.clientX, y: t.clientY, at: e.timeStamp } : null;
  }, { passive: true });
  el.addEventListener('touchmove', (e) => { if (e.touches.length > 1) start = null; }, { passive: true });
  el.addEventListener('touchcancel', () => { start = null; }, { passive: true });
  el.addEventListener('touchend', (e) => {
    if (!start) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    const quick = e.timeStamp - start.at < 700;
    start = null;
    if (quick && Math.abs(dx) >= 48 && Math.abs(dx) > Math.abs(dy) * 1.6) fn(dx < 0 ? 1 : -1);
  }, { passive: true });
}
