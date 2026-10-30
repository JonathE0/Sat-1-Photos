/**
 * The orbit's colour on the orbit page: a small hue ring you drag round,
 * a lightness slider and a few presets, opened from a swatch button. The
 * colour goes to the orbit line, ground track, footprint and satellite in
 * both views, and each visitor's choice is remembered in their browser.
 * Lightness is raised where needed so the line keeps 4.5:1 contrast with
 * the night side (#05070A) and never disappears into it.
 *
 *   const wheel = createColorWheel({ onChange: (hex) => paintOrbit(hex) });
 *   viewsBar.append(wheel.button);
 *   root.append(wheel.element);
 *   paintOrbit(wheel.colour);
 *
 * The colour helpers above createColorWheel are pure, so
 * fixtures/verify.mjs checks them under Node.
 */

/** CalgaryToSpace's blue: the orbit's colour unless a visitor picks another. */
export const TEAM_BLUE = '#3C9DF5';
const SPACE = '#05070A';
/** WCAG's contrast for text, kept for a 2px line over the dark Earth. */
export const MIN_CONTRAST = 4.5;
const SATURATION = 90;
export const LIGHTNESS = { min: 50, max: 80 };
const STORE_KEY = 'cts-globe-orbit-colour';

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function rgbToHex({ r, g, b }) {
  const to = (v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`.toUpperCase();
}

/** h in degrees, s and l in percent. */
export function hslToRgb(h, s, l) {
  const sat = s / 100;
  const light = l / 100;
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const hh = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const [r, g, b] =
    hh < 1 ? [c, x, 0] : hh < 2 ? [x, c, 0] : hh < 3 ? [0, c, x] : hh < 4 ? [0, x, c] : hh < 5 ? [x, 0, c] : [c, 0, x];
  const m = light - c / 2;
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

export function rgbToHsl({ r, g, b }) {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l: l * 100 };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return { h: (h * 60 + 360) % 360, s: s * 100, l: l * 100 };
}

function luminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  const lin = (v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio between two colours, 1 to 21. */
export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** The colour for a hue at a lightness (percent), made lighter where it
 * needs to be to keep MIN_CONTRAST against the night side. */
export function readableColour(h, l) {
  let light = Math.max(LIGHTNESS.min, Math.min(LIGHTNESS.max, l));
  let hex = rgbToHex(hslToRgb(h, SATURATION, light));
  while (contrast(hex, SPACE) < MIN_CONTRAST && light < 95) {
    light += 0.5;
    hex = rgbToHex(hslToRgb(h, SATURATION, light));
  }
  return hex;
}

/** Is this a colour the page will use (a hex colour clear of the night side)? */
export function usable(hex) {
  return !!hexToRgb(hex) && contrast(hex, SPACE) >= MIN_CONTRAST;
}

/** A few quieter picks than the wheel's full-strength colours. */
export const PRESETS = [
  { name: 'Team blue', hex: TEAM_BLUE },
  { name: 'Green', hex: '#46C589' },
  { name: 'Amber', hex: '#E9B04B' },
  { name: 'Pink', hex: '#EE7DB1' },
  { name: 'Violet', hex: '#A88CF2' },
];

/** A word for a hue, for screen readers: "blue", "amber". */
export function hueName(h) {
  const names = [
    [15, 'red'], [40, 'orange'], [55, 'amber'], [70, 'yellow'], [160, 'green'], [195, 'cyan'],
    [250, 'blue'], [290, 'violet'], [345, 'pink'], [360, 'red'],
  ];
  const hue = ((h % 360) + 360) % 360;
  return names.find(([end]) => hue < end)[1];
}

// ---- the control -------------------------------------------------------------------

const CLOSE_ICON =
  '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" stroke-width="1.3"/></svg>';

function load(key) {
  try {
    const v = localStorage.getItem(key);
    return v && usable(v) ? v.toUpperCase() : null;
  } catch {
    return null; // storage blocked: the team blue, for this visit
  }
}

function save(key, hex) {
  try {
    if (hex === TEAM_BLUE) localStorage.removeItem(key);
    else localStorage.setItem(key, hex);
  } catch {
    // storage blocked: the choice lasts until the page closes
  }
}

/**
 * @param {object} o
 * @param {(hex: string) => void} o.onChange  called with every new colour
 * @param {string} [o.storageKey]
 */
export function createColorWheel({ onChange = () => {}, storageKey = STORE_KEY } = {}) {
  let hex = load(storageKey) || TEAM_BLUE;
  let { h, l } = rgbToHsl(hexToRgb(hex));
  let trigger = null;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'cg-swatch';
  button.title = 'Orbit colour';
  button.setAttribute('aria-label', 'Orbit colour');
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-expanded', 'false');
  button.innerHTML = '<span class="cg-swatch-chip" aria-hidden="true"></span>';

  const panel = document.createElement('div');
  panel.className = 'cg-cw';
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Orbit colour');
  panel.innerHTML = `
    <div class="cg-cw-head">
      <h2 class="cg-cw-title">Orbit colour</h2>
      <button type="button" class="cg-icon-btn cg-cw-close" data-cw="close" aria-label="Close">${CLOSE_ICON}</button>
    </div>
    <div class="cg-cw-wheel" data-cw="wheel" role="slider" tabindex="0" aria-label="Hue"
      aria-valuemin="0" aria-valuemax="359">
      <div class="cg-cw-ring" data-cw="ring" aria-hidden="true"></div>
      <div class="cg-cw-centre" aria-hidden="true"></div>
      <div class="cg-cw-handle" aria-hidden="true"></div>
    </div>
    <label class="cg-cw-light"><span class="cg-fine">Lightness</span>
      <input type="range" data-cw="light" min="${LIGHTNESS.min}" max="${LIGHTNESS.max}" step="1"></label>
    <div class="cg-cw-presets" role="group" aria-label="Presets">
      ${PRESETS.map((p) => `<button type="button" class="cg-cw-preset" data-hex="${p.hex}" aria-label="${p.name}"
        aria-pressed="false" title="${p.name}"><span style="background:${p.hex}"></span></button>`).join('')}
    </div>
    <button type="button" class="cg-btn cg-cw-reset" data-cw="reset">Reset to team blue</button>
  `;
  const $ = (name) => panel.querySelector(`[data-cw="${name}"]`);
  const wheel = $('wheel');
  const ring = $('ring');
  const light = $('light');
  let ringFor = null;

  function paint() {
    for (const node of [button, panel]) node.style.setProperty('--cg-cw-colour', hex);
    panel.style.setProperty('--cg-cw-hue', `${h}deg`);
    wheel.setAttribute('aria-valuenow', String(Math.round(h)));
    wheel.setAttribute('aria-valuetext', `${Math.round(h)} degrees, ${hueName(h)}`);
    light.value = String(Math.round(Math.max(LIGHTNESS.min, Math.min(LIGHTNESS.max, l))));
    // the ring shows the colours this lightness gives
    const lightness = Math.round(l);
    if (ringFor !== lightness) {
      ringFor = lightness;
      const stops = [];
      for (let a = 0; a <= 360; a += 15) stops.push(`${readableColour(a, l)} ${a}deg`);
      ring.style.background = `conic-gradient(${stops.join(', ')})`;
    }
    for (const b of panel.querySelectorAll('.cg-cw-preset')) {
      b.setAttribute('aria-pressed', String(b.dataset.hex === hex));
    }
    $('reset').disabled = hex === TEAM_BLUE;
  }

  function set(next) {
    if (next === hex) {
      paint();
      return;
    }
    hex = next;
    save(storageKey, hex);
    paint();
    onChange(hex);
  }

  function setHue(next) {
    h = ((next % 360) + 360) % 360;
    set(readableColour(h, l));
  }

  function setPicked(next) {
    ({ h, l } = rgbToHsl(hexToRgb(next)));
    set(next);
  }

  // drag round the ring (or anywhere in the wheel)
  function hueAt(e) {
    const r = wheel.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    return (Math.atan2(dx, -dy) * 180) / Math.PI;
  }
  let dragging = null;
  wheel.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button > 0) return;
    dragging = e.pointerId;
    wheel.setPointerCapture?.(e.pointerId);
    wheel.focus();
    setHue(hueAt(e));
    e.preventDefault();
  });
  wheel.addEventListener('pointermove', (e) => {
    if (e.pointerId === dragging) setHue(hueAt(e));
  });
  const stop = (e) => {
    if (e.pointerId !== dragging) return;
    dragging = null;
    wheel.releasePointerCapture?.(e.pointerId);
  };
  wheel.addEventListener('pointerup', stop);
  wheel.addEventListener('pointercancel', stop);

  // the page uses the arrow keys for time: the wheel keeps them while focused
  wheel.addEventListener('keydown', (e) => {
    const big = e.shiftKey ? 30 : 5;
    const moves = { ArrowRight: big, ArrowUp: big, ArrowLeft: -big, ArrowDown: -big, PageUp: 30, PageDown: -30 };
    if (e.key in moves) setHue(h + moves[e.key]);
    else if (e.key === 'Home') setHue(0);
    else if (e.key === 'End') setHue(359);
    else return;
    e.preventDefault();
    e.stopPropagation();
  });

  light.addEventListener('input', () => {
    l = Number(light.value);
    set(readableColour(h, l));
  });
  light.addEventListener('keydown', (e) => {
    if (e.key.startsWith('Arrow')) e.stopPropagation();
  });
  for (const b of panel.querySelectorAll('.cg-cw-preset')) {
    b.addEventListener('click', () => setPicked(b.dataset.hex));
  }
  $('reset').addEventListener('click', () => {
    setPicked(TEAM_BLUE);
    wheel.focus(); // the button disables itself: keep the focus in the panel
  });

  function open() {
    trigger = button;
    panel.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    paint();
    wheel.focus();
  }

  function close({ restoreFocus = true } = {}) {
    if (panel.hidden) return;
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (restoreFocus) trigger?.focus();
  }

  button.addEventListener('click', () => (panel.hidden ? open() : close()));
  $('close').addEventListener('click', () => close());
  // on the document: Escape still closes it after Tab has left it
  const onEscape = (e) => {
    if (e.key !== 'Escape' || panel.hidden) return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  document.addEventListener('keydown', onEscape, true);
  const outside = (e) => {
    if (panel.hidden || panel.contains(e.target) || button.contains(e.target)) return;
    close({ restoreFocus: false });
  };
  document.addEventListener('pointerdown', outside, true);

  paint();

  return {
    button,
    element: panel,
    get colour() {
      return hex;
    },
    open,
    close,
    destroy() {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', onEscape, true);
      button.remove();
      panel.remove();
    },
  };
}
