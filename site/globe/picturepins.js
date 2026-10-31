/**
 * The pictures on Orbit's globe as little pictures, as on Explore: a thumbnail
 * where each was taken, piled up where they fall close together, with a count.
 *
 * They only show. The pointer passes through, so a drag that starts on one still
 * turns the globe, and scene.pick() decides what's under the pointer as it always
 * has. For the keyboard and screen readers the Pictures list is the way in.
 *
 *   const pins = createPicturePins(layer);
 *   pins.setPins([{ id, thumb, dark, square }]);   // newest first: the newest tops a pile
 *   // after a frame is drawn: pins.place(new Map([[id, { x, y }]]));  // left out = hidden
 */

/** Pins closer than this stack under the newest, in px at scale 1. */
const NEAR_PX = 28;

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
      return { id: p.id, el, count, x: 0, y: 0, vis: false, pile: null, key: '' };
    });
    setSelected(selectedId);
  }

  function setSelected(id) {
    selectedId = id;
    for (const pin of pins) pin.el.classList.toggle('is-selected', pin.id === id);
  }

  function place(points, scale = 1) {
    for (const pin of pins) {
      const s = points.get(pin.id);
      pin.vis = Boolean(s);
      pin.pile = null;
      if (s) {
        pin.x = s.x;
        pin.y = s.y;
      }
    }
    const near = NEAR_PX * scale;
    for (let i = 0; i < pins.length; i++) {
      const a = pins[i];
      if (!a.vis || a.pile) continue;
      const members = [a];
      for (let j = i + 1; j < pins.length; j++) {
        const b = pins[j];
        if (b.vis && !b.pile && Math.hypot(a.x - b.x, a.y - b.y) < near) members.push(b);
      }
      if (members.length > 1) {
        members.forEach((m, k) => {
          m.pile = { head: a, index: k, members };
        });
      }
    }
    for (const pin of pins) {
      const pile = pin.pile;
      const x = pile ? pile.head.x + pile.index * 3 : pin.x;
      const y = pile ? pile.head.y - pile.index * 3 : pin.y;
      const key = pin.vis ? `${Math.round(x)},${Math.round(y)},${pile ? pile.index : -1}` : 'off';
      if (pin.key !== key) {
        pin.key = key;
        pin.el.classList.toggle('is-off', !pin.vis);
        if (pin.vis) {
          pin.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, -50%)`;
          pin.el.style.zIndex = String(pile ? 100 - pile.index : 100);
        }
      }
      if (pile?.index === 0) {
        pin.count.hidden = false;
        pin.count.textContent = `${pile.members.length} pictures`;
        pin.count.style.transform = `translate(${Math.round(pin.x + 24 * scale)}px, ${Math.round(pin.y)}px) translateY(-50%)`;
      } else if (!pin.count.hidden) {
        pin.count.hidden = true;
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
