/**
 * "Go to a time" for the orbit page: a small form where you type or pick a
 * date and time in UTC, see the same moment in Calgary, and read how far the
 * orbital elements behind it are from that moment.
 *
 *   const picker = createTimePicker({ launchMs, getOrbit: () => orbit, onPick: (ms) => jump(ms) });
 *   root.appendChild(picker.element);
 *   picker.open(currentMs, triggerButton);
 *
 * The helpers above createTimePicker are pure, so fixtures/verify.mjs checks
 * them under Node.
 */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const LOCAL_ZONE = 'America/Edmonton';
/** Past this many days from the elements, say how far off the position may
 * be; past VERY_FAR_DAYS, that the timing is a rough guess. SGP4's error
 * for a low, drag-affected orbit grows from a few kilometres at the epoch
 * to tens after a week and hundreds or more after a few weeks, mostly
 * along the track. */
export const FAR_DAYS = 7;
export const VERY_FAR_DAYS = 14;

/** "tens of kilometres" or "hundreds of kilometres or more": how far off a
 * position worked out `days` from its elements may be (past FAR_DAYS). */
export function offBy(days) {
  return Math.abs(days) > VERY_FAR_DAYS ? 'hundreds of kilometres or more' : 'tens of kilometres';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');

/** UTC milliseconds from an <input type="date"> value ("2026-10-22") and a
 * typed 24-hour time ("15:07", "15:07:59", "1507" or "150759"), or NaN. */
export function parseUtcInput(date, time) {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || '').trim());
  const typed = String(time || '').trim();
  const t =
    /^(\d{1,2})[:.h ](\d{2})(?:[:.m ](\d{2})(?:\.\d+)?)?$/.exec(typed) ||
    /^(\d{2})(\d{2})(\d{2})?$/.exec(typed);
  if (!d || !t) return NaN;
  const [y, mo, day] = [Number(d[1]), Number(d[2]), Number(d[3])];
  const [h, mi, s] = [Number(t[1]), Number(t[2]), Number(t[3] || 0)];
  if (mo < 1 || mo > 12 || day < 1 || day > 31 || h > 23 || mi > 59 || s > 59) return NaN;
  const ms = Date.UTC(y, mo - 1, day, h, mi, s);
  // reject 31 June and the like rather than rolling over into July
  return new Date(ms).getUTCDate() === day ? ms : NaN;
}

/** The input values for a moment: { date: "2026-10-22", time: "15:07:59" }. */
export function utcInputs(ms) {
  const d = new Date(Math.floor(ms / 1000) * 1000);
  return {
    date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`,
  };
}

/** "Oct 27, 22:38 UTC", with the year when it isn't `yearOf`'s. */
function when(ms, yearOf = ms) {
  const d = new Date(ms);
  const year = d.getUTCFullYear() !== new Date(yearOf).getUTCFullYear() ? `, ${d.getUTCFullYear()}` : '';
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}${year}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** "5 hours", "1 day", "40 days". */
function span(ms) {
  const hours = Math.abs(ms) / HOUR_MS;
  const n = hours < 24 ? Math.max(1, Math.round(hours)) : Math.round(hours / 24);
  return `${n} ${hours < 24 ? 'hour' : 'day'}${n === 1 ? '' : 's'}`;
}

/**
 * How good the position at `ms` is: which orbital elements it comes from and
 * how far they are from that moment. `level` is 'ok', or 'far' when the
 * moment is more than FAR_DAYS from the elements, which the page shows more
 * strongly. `orbit` is an astro.Orbit.
 */
export function elementsNote(ms, orbit) {
  if (!orbit) return { text: 'The orbital elements are still loading.', level: 'ok', days: null };
  const item = orbit.items[orbit.indexAt(ms)];
  const age = ms - item.epochMs;
  const days = age / DAY_MS;
  const of = when(item.epochMs, ms);
  if (ms < orbit.firstEpochMs) {
    return {
      text:
        `Worked out from the first orbital elements published (${of}, ${span(age)} later). ` +
        'None exist from before then, so the position is approximate.',
      level: Math.abs(days) > FAR_DAYS ? 'far' : 'ok',
      days,
    };
  }
  if (ms > orbit.lastEpochMs && days > VERY_FAR_DAYS) {
    return {
      text:
        `A forecast ${span(age)} past the newest orbital elements (${of}). ` +
        `This far out the satellite could be ${offBy(days)} ahead of or behind where it is drawn, ` +
        'so the time it passes any place is a rough guess.',
      level: 'far',
      days,
    };
  }
  if (ms > orbit.lastEpochMs && days > FAR_DAYS) {
    return {
      text:
        `A forecast ${span(age)} past the newest orbital elements (${of}), ` +
        `so the position may be off by ${offBy(days)}, mostly along the track.`,
      level: 'far',
      days,
    };
  }
  return {
    text:
      ms > orbit.lastEpochMs
        ? `Forecast from the newest orbital elements (${of}, ${span(age)} old).`
        : `Worked out from orbital elements of ${of} (${span(age)} old).`,
    level: 'ok',
    days,
  };
}

// ---- the form -----------------------------------------------------------------------

const localDay = new Intl.DateTimeFormat('en-US', {
  timeZone: LOCAL_ZONE,
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});
const localClock = new Intl.DateTimeFormat('en-US', {
  timeZone: LOCAL_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
  timeZoneName: 'short',
});

/** "Thursday, October 22, 2026, 09:07:59 MDT" */
export function calgaryWhen(ms) {
  const p = {};
  for (const part of [...localDay.formatToParts(ms), ...localClock.formatToParts(ms)]) p[part.type] = part.value;
  return `${p.weekday}, ${p.month} ${p.day}, ${p.year}, ${p.hour}:${p.minute}:${p.second} ${p.timeZoneName}`;
}

const CLOSE_ICON =
  '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" stroke-width="1.3"/></svg>';

/**
 * @param {object} o
 * @param {number} o.launchMs        nothing before this can be picked
 * @param {() => object|null} o.getOrbit  the astro.Orbit, or null while loading
 * @param {(ms: number) => void} o.onPick
 * @param {() => void} [o.onClose]
 * @param {(ms: number) => void} [o.onPreview]  offer "Preview picture" for the time in the form
 */
export function createTimePicker({ launchMs, getOrbit, onPick, onClose = () => {}, onPreview = null }) {
  const form = document.createElement('form');
  form.className = 'cg-tp';
  form.hidden = true;
  form.noValidate = true;
  form.setAttribute('role', 'dialog');
  form.setAttribute('aria-label', 'Go to a time');
  const launch = utcInputs(launchMs);
  form.innerHTML = `
    <div class="cg-tp-head">
      <h2 class="cg-tp-title">Go to a time</h2>
      <button type="button" class="cg-icon-btn cg-tp-close" data-tp="close" aria-label="Close">${CLOSE_ICON}</button>
    </div>
    <div class="cg-tp-fields">
      <label class="cg-tp-field"><span class="cg-fine">Date, UTC</span>
        <input type="date" name="date" min="${launch.date}" required></label>
      <label class="cg-tp-field"><span class="cg-fine">Time, UTC (24-hour)</span>
        <input type="text" name="time" inputmode="numeric" autocomplete="off" spellcheck="false"
          placeholder="15:07:59" maxlength="12" required></label>
    </div>
    <p class="cg-tp-local" data-tp="local" aria-live="polite"></p>
    <p class="cg-fine cg-tp-note" data-tp="note" aria-live="polite"></p>
    <div class="cg-tp-actions">
      <button type="submit" class="cg-btn cg-tp-go" data-tp="go">Show this time</button>
      <button type="button" class="cg-btn" data-tp="shot"${onPreview ? '' : ' hidden'}>Preview picture</button>
      <button type="button" class="cg-btn" data-tp="launch">Launch</button>
    </div>
  `;
  const $ = (name) => form.querySelector(`[data-tp="${name}"]`);
  const date = form.elements.date;
  const time = form.elements.time;
  const local = $('local');
  const note = $('note');
  const go = $('go');
  const shot = $('shot');
  let trigger = null;

  function chosen() {
    return parseUtcInput(date.value, time.value);
  }

  function paint() {
    const ms = chosen();
    let ok = Number.isFinite(ms);
    if (!ok) {
      local.textContent = 'Type a date such as 2026-10-22 and a time such as 15:07.';
      note.textContent = '';
      note.dataset.level = 'ok';
    } else if (ms < launchMs) {
      ok = false;
      local.textContent = `In Calgary: ${calgaryWhen(ms)}.`;
      note.textContent = `That is before launch. CTS-SAT-1 went up on ${when(launchMs, 0)}; pick a time after that.`;
      note.dataset.level = 'far';
    } else {
      local.textContent = `In Calgary: ${calgaryWhen(ms)}.`;
      const n = elementsNote(ms, getOrbit());
      note.textContent = n.text;
      note.dataset.level = n.level;
    }
    go.disabled = !ok;
    shot.disabled = !ok;
    return ok ? ms : NaN;
  }

  function fill(ms) {
    const v = utcInputs(ms);
    date.value = v.date;
    time.value = v.time;
    paint();
  }

  function close({ restoreFocus = true } = {}) {
    if (form.hidden) return;
    form.hidden = true;
    trigger?.setAttribute('aria-expanded', 'false');
    if (restoreFocus) trigger?.focus();
    onClose();
  }

  function open(ms, anchor = null) {
    trigger = anchor;
    fill(Math.max(ms, launchMs));
    form.hidden = false;
    trigger?.setAttribute('aria-expanded', 'true');
    date.focus();
  }

  form.addEventListener('input', paint);
  form.addEventListener('change', paint);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const ms = paint();
    if (!Number.isFinite(ms)) return;
    close();
    onPick(ms);
  });
  // on the document: Escape still closes it after Tab has left it
  const onEscape = (e) => {
    if (e.key !== 'Escape' || form.hidden) return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  document.addEventListener('keydown', onEscape, true);
  $('close').addEventListener('click', () => close());
  shot.addEventListener('click', () => {
    const ms = paint();
    if (!Number.isFinite(ms)) return;
    close();
    onPreview?.(ms);
  });
  $('launch').addEventListener('click', () => {
    fill(launchMs);
    date.focus();
  });

  // a click anywhere else puts it away
  const outside = (e) => {
    if (form.hidden || form.contains(e.target) || trigger?.contains(e.target)) return;
    close({ restoreFocus: false });
  };
  document.addEventListener('pointerdown', outside, true);

  return {
    element: form,
    open,
    close,
    toggle(ms, anchor) {
      if (form.hidden) open(ms, anchor);
      else close();
    },
    /** Repaint the note, e.g. once the orbital elements have loaded. */
    refresh() {
      if (!form.hidden) paint();
    },
    get isOpen() {
      return !form.hidden;
    },
    destroy() {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', onEscape, true);
      form.remove();
    },
  };
}
