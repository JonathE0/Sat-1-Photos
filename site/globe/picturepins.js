/**
 * The pictures on Orbit's globe and map as little pictures, as on Explore: a
 * thumbnail where each was taken, piled up where they fall close together, with
 * a count.
 *
 * They only show. The pointer passes through, so a drag that starts on one still
 * moves the view, and the view's pick() decides what's under the pointer as it
 * always has. For the keyboard and screen readers the Pictures list is the way in.
 *
 *   const pins = createPicturePins(layer);
 *   pins.setPins([{ id, thumb, dark, square }]);   // newest first: the newest tops a pile
 *   // after a frame is drawn: pins.place(new Map([[id, { x, y }]]));  // left out = hidden
 *
 * On a phone (`compact`) a pile is one pin with its number on a badge, and a pin
 * shows only where it fits: inside `bounds` (the stage the header, bar and sheets
 * leave) and clear of every box in `avoid` (the names of FrontierSat and Calgary,
 * their marks and the buttons over the stage). The chosen picture always shows.
 */

/** Pins closer than this stack under the newest, in px at scale 1. */
const NEAR_PX = 28;
/** How far a pile's badge reaches past its pin's top right corner, px. */
const BADGE_PX = 9;

/** A pin's drawn size at a scale (globe.css .cg-pin and its kinds). */
function pinSize(pin, scale, selected) {
  if (pin.dark) return selected ? { w: 15, h: 15 } : { w: 10, h: 10 };
  const k = selected ? 1.5 : 1;
  return { w: (pin.square ? 24 : 32) * k * scale + 4, h: 24 * k * scale + 4 };
}

const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

export function createPicturePins(layer) {
  let pins = [];
  let selectedId = null;

  function setPins(list) {
    for (const pin of pins) {
      pin.el.remove();
      pin.count.remove();
    }
    pins = list.map((p) => {
      const el = document.createElement('span');
      el.className = 'cg-pin is-off';
      el.classList.toggle('cg-pin-square', Boolean(p.square));
      // a dark frame has nothing to show at this size: a small dim mark
      el.classList.toggle('cg-pin-dark', Boolean(p.dark));
      if (!p.dark && p.thumb) {
        const img = document.createElement('img');
        img.alt = '';
        img.decoding = 'async';
        img.addEventListener('error', () => { img.hidden = true; }); // an empty pin, not a broken icon
        img.src = p.thumb;
        el.appendChild(img);
      }
      const count = document.createElement('span');
      count.className = 'cg-pile-count';
      count.hidden = true;
      layer.append(el, count);
      return { id: p.id, el, count, dark: Boolean(p.dark), square: Boolean(p.square), x: 0, y: 0, vis: false, pile: null, key: '', countKey: '' };
    });
    setSelected(selectedId);
  }

  function setSelected(id) {
    selectedId = id;
    for (const pin of pins) pin.el.classList.toggle('is-selected', pin.id === id);
  }

  /**
   * @param {Map<string, {x: number, y: number}>} points  where each pin is on the stage; left out = hidden
   * @param {number} [scale]  the page's type scale
   * @param {{compact?: boolean, bounds?: {left: number, top: number, right: number, bottom: number}|null,
   *          avoid?: {left: number, top: number, right: number, bottom: number}[]}} [opts]
   */
  function place(points, scale = 1, { compact = false, bounds = null, avoid = [] } = {}) {
    for (const pin of pins) {
      const s = points.get(pin.id);
      pin.vis = Boolean(s);
      pin.pile = null;
      if (s) {
        pin.x = s.x;
        pin.y = s.y;
      }
    }
    // a phone piles what would touch: closer than a pin's width across or its height down
    const across = 32 * scale + 8;
    const down = 24 * scale + 8;
    const near = compact
      ? (a, b) => Math.abs(a.x - b.x) < across && Math.abs(a.y - b.y) < down
      : (a, b) => Math.hypot(a.x - b.x, a.y - b.y) < NEAR_PX * scale;
    for (let i = 0; i < pins.length; i++) {
      const a = pins[i];
      if (!a.vis || a.pile) continue;
      const members = [a];
      for (let j = i + 1; j < pins.length; j++) {
        const b = pins[j];
        if (b.vis && !b.pile && near(a, b)) members.push(b);
      }
      if (members.length > 1) {
        // on a phone the pile shows as the chosen picture if it holds it, else its newest
        const top = (compact && members.find((m) => m.id === selectedId)) || a;
        members.forEach((m, k) => {
          m.pile = { head: a, top, index: k, members };
        });
      }
    }
    for (const pin of pins) {
      const pile = pin.pile;
      let shown = pin.vis;
      let x = pin.x;
      let y = pin.y;
      if (compact) {
        // one pin a pile, where it has room
        if (shown && pile) shown = pile.top === pin;
        if (shown && pin.id !== selectedId && !(pile?.members.some((m) => m.id === selectedId))) {
          const { w, h } = pinSize(pin, scale, false);
          const badge = pile ? BADGE_PX : 0;
          const box = { left: x - w / 2, top: y - h / 2 - badge, right: x + w / 2 + badge, bottom: y + h / 2 };
          const inside = !bounds || (box.left >= bounds.left && box.right <= bounds.right && box.top >= bounds.top && box.bottom <= bounds.bottom);
          shown = inside && !avoid.some((a) => overlaps(box, a));
        }
      } else if (pile) {
        x = pile.head.x + pile.index * 3;
        y = pile.head.y - pile.index * 3;
      }
      const key = shown ? `${Math.round(x)},${Math.round(y)},${pile && !compact ? pile.index : -1}` : 'off';
      if (pin.key !== key) {
        pin.key = key;
        pin.el.classList.toggle('is-off', !shown);
        if (shown) {
          pin.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, -50%)`;
          pin.el.style.zIndex = String(pile && !compact ? 100 - pile.index : 100);
        }
      }
      // the count: "3 pictures" beside a pile, or on a phone a "3" badge on its pin's corner
      const counted = compact ? shown && pile : pile?.index === 0;
      if (counted) {
        const n = pile.members.length;
        let countKey;
        if (compact) {
          const { w, h } = pinSize(pin, scale, pin.id === selectedId);
          countKey = `b${n},${Math.round(x + w / 2)},${Math.round(y - h / 2)}`;
        } else {
          countKey = `t${n},${Math.round(pin.x + 24 * scale)},${Math.round(pin.y)}`;
        }
        if (pin.count.hidden) pin.count.hidden = false;
        if (pin.countKey !== countKey) {
          pin.countKey = countKey;
          pin.count.classList.toggle('is-badge', compact);
          if (compact) {
            const { w, h } = pinSize(pin, scale, pin.id === selectedId);
            pin.count.textContent = String(n);
            pin.count.style.transform = `translate(${Math.round(x + w / 2)}px, ${Math.round(y - h / 2)}px) translate(-50%, -50%)`;
          } else {
            pin.count.textContent = `${n} pictures`;
            pin.count.style.transform = `translate(${Math.round(pin.x + 24 * scale)}px, ${Math.round(pin.y)}px) translateY(-50%)`;
          }
        }
      } else if (!pin.count.hidden) {
        pin.count.hidden = true;
        pin.countKey = '';
      }
    }
  }

  /** The pictures piled with this one, newest first; just itself when it's on its own. */
  function pileOf(id) {
    const pin = pins.find((p) => p.id === id);
    return pin?.pile ? pin.pile.members.map((m) => m.id) : [id];
  }

  return { setPins, setSelected, place, pileOf };
}
