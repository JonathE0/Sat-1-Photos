/**
 * Where to put a marker's label so it stays clear of something more
 * important: to the right of the marker if it can, else to its left, below
 * or above; null means hide it for now. Used for "Calgary" when CTS-SAT-1 is
 * overhead, on the globe and the map alike.
 *
 * A label leaves its usual place as soon as it overlaps, but only comes back
 * once it is clear by a few pixels, so two labels drifting past each other
 * don't make it flicker. No DOM, so fixtures/verify.mjs checks it.
 */

const SIDES = ['right', 'left', 'below', 'above'];

/** The box of a w x h label on `side` of a marker at (x, y), `gap` px off it. */
export function labelBox(side, { x, y, w, h, gap }) {
  if (side === 'left') return { left: x - gap - w, top: y - h / 2, right: x - gap, bottom: y + h / 2 };
  if (side === 'below') return { left: x - w / 2, top: y + gap, right: x + w / 2, bottom: y + gap + h };
  if (side === 'above') return { left: x - w / 2, top: y - gap - h, right: x + w / 2, bottom: y - gap };
  return { left: x + gap, top: y - h / 2, right: x + gap + w, bottom: y + h / 2 };
}

function clear(box, avoid, margin) {
  return avoid.every(
    (a) =>
      box.right + margin <= a.left || box.left - margin >= a.right || box.bottom + margin <= a.top || box.top - margin >= a.bottom,
  );
}

/**
 * @param {{x: number, y: number, w: number, h: number, gap: number}} label
 * @param {{left: number, top: number, right: number, bottom: number}[]} avoid
 * @param {string|null} [current] where it is now: 'right', 'left', 'below', 'above' or null (hidden)
 * @param {number} [margin] how clear it must be to come back, px
 * @returns {string|null}
 */
export function placeLabel(label, avoid, current = 'right', margin = 6) {
  const fits = (side, m = 0) => clear(labelBox(side, label), avoid, m);
  if (fits('right', current === 'right' ? 0 : margin)) return 'right';
  if (current && current !== 'right' && fits(current)) return current;
  const m = current === null ? margin : 0;
  return SIDES.slice(1).find((side) => fits(side, m)) ?? null;
}
