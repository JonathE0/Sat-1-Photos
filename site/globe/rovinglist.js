/**
 * One Tab stop for a group of buttons, with the arrow keys inside it: the
 * "roving tabindex" pattern. Tab reaches the group's current button and the
 * next Tab leaves the group, so a keyboard user can get past a long list.
 *
 * The markup stays a real list of real buttons, not a listbox, so a screen
 * reader's browse mode still reads every row and can press any of them, and a
 * row may hold more than one button. Say how it works in the list's
 * aria-label: its focus mode needs the arrow keys and won't guess.
 *
 *   const list = rovingList(ul);            // Up, Down, Home, End
 *   const row = rovingList(group, { axis: 'horizontal' });   // Left, Right too
 *   list.repaint(() => { ul.replaceChildren(...rows); });    // keeps the focus
 */

const FORWARD = { vertical: ['ArrowDown'], horizontal: ['ArrowRight', 'ArrowDown'] };
const BACK = { vertical: ['ArrowUp'], horizontal: ['ArrowLeft', 'ArrowUp'] };

/**
 * @param {HTMLElement} container
 * @param {object} [o]
 * @param {string} [o.items]  which elements inside are the stops
 * @param {'vertical'|'horizontal'} [o.axis]  a horizontal group also takes
 *   Left and Right, and wraps round at its ends as a row of toggles does
 */
export function rovingList(container, { items = 'button', axis = 'vertical' } = {}) {
  let current = null;
  const all = () =>
    [...container.querySelectorAll(items)].filter((el) => {
      const hiddenBy = el.closest('[hidden]');
      return !el.disabled && (!hiddenBy || !container.contains(hiddenBy) || hiddenBy === container);
    });
  const chosen = (list) => list.find((el) => el.getAttribute('aria-current') === 'true' || el.getAttribute('aria-pressed') === 'true');

  function setStops(list = all()) {
    for (const el of list) el.tabIndex = el === current ? 0 : -1;
  }

  /** Make sure exactly one button is the stop, after the buttons changed. */
  function refresh() {
    const list = all();
    if (!list.includes(current)) current = chosen(list) || list[0] || null;
    setStops(list);
  }

  container.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const list = all();
    const i = list.indexOf(e.target.closest?.(items));
    if (i < 0) return;
    let next;
    if (FORWARD[axis].includes(e.key)) next = list[i + 1] ?? (axis === 'horizontal' ? list[0] : list[i]);
    else if (BACK[axis].includes(e.key)) next = list[i - 1] ?? (axis === 'horizontal' ? list[list.length - 1] : list[i]);
    else if (e.key === 'Home') next = list[0];
    else if (e.key === 'End') next = list[list.length - 1];
    else return;
    // these keys belong to the group while it has the focus
    e.preventDefault();
    e.stopPropagation();
    current = next;
    setStops(list);
    next.focus();
    next.scrollIntoView?.({ block: 'nearest' });
  });

  container.addEventListener('focusin', (e) => {
    const el = e.target.closest?.(items);
    if (el && el !== current && all().includes(el)) {
      current = el;
      setStops();
    }
  });

  refresh();

  return {
    refresh,
    /** The stop follows the chosen button, unless the focus is in the group. */
    sync() {
      if (container.contains(document.activeElement)) return;
      current = chosen(all()) || current;
      refresh();
    },
    /** Rebuild the buttons with `build`, keeping the stop and the focus on the
     * same row (by data-id, else by position). */
    repaint(build) {
      const before = all();
      const active = document.activeElement;
      const focused = active && container.contains(active) ? before.indexOf(active.closest?.(items)) : -1;
      const at = before.indexOf(current);
      const id = current?.dataset?.id;
      build();
      const list = all();
      const same = (id && list.find((el) => el.dataset.id === id)) || list[Math.min(Math.max(at, 0), list.length - 1)] || null;
      current = focused >= 0 ? same : chosen(list) || same;
      setStops(list);
      if (focused >= 0) current?.focus({ preventScroll: true });
    },
  };
}
