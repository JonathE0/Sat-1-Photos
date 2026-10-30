// The watchlist page: reads data/watchlist.json (written by
// `python -m cts1_gallery watch`, format in docs/DATA.md) and lists each
// event by its next pass that hasn't happened yet. Every time and age is
// worked out against the visitor's clock, so a list made an hour ago still
// drops the passes that are over.
(() => {
  'use strict';

  const DATA_URL = '../data/watchlist.json';
  const ORBIT_URL = '../globe/';
  const TZ = 'America/Edmonton';
  const STALE_HOURS = 3; // the list is rebuilt about once an hour

  const CATEGORIES = {
    storm: ['Storm', 'Storms'],
    wildfire: ['Wildfire', 'Wildfires'],
    volcano: ['Volcano', 'Volcanoes'],
    flood: ['Flood', 'Floods'],
    dust: ['Dust and haze', 'Dust and haze'],
    ice: ['Sea and lake ice', 'Ice'],
    water: ['Water colour', 'Water colour'],
    snow: ['Snow', 'Snow'],
    manmade: ['Made by people', 'Made by people'],
    aurora: ['Aurora', 'Aurora'],
  };

  const $ = (id) => document.getElementById(id);
  const el = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid);
    return n;
  };
  const small = (text, cls = '') => el('span', { class: `small ${cls}`.trim(), text });

  // -- formatting -----------------------------------------------------------

  const calgaryFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const utcFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const zoneFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'short' });
  const zone = (ms) => (zoneFmt.formatToParts(ms).find((p) => p.type === 'timeZoneName') || {}).value || '';
  const calgary = (ms) => `${calgaryFmt.format(ms)} ${zone(ms)}`; // "Sat 31 Oct, 02:33 MDT"
  const utc = (ms) => `${utcFmt.format(ms)} UTC`; // "31 Oct, 08:33 UTC"
  const num = (x, digits = 0) => x.toLocaleString('en-GB', { maximumFractionDigits: digits, minimumFractionDigits: digits });

  function span(ms) {
    const m = Math.round(Math.abs(ms) / 60000);
    if (m < 1) return 'under a minute';
    if (m < 60) return `${m} min`;
    if (m < 48 * 60) {
      const h = Math.floor(m / 60), r = m % 60;
      return r ? `${h} h ${r} min` : `${h} h`;
    }
    const d = Math.floor(m / 1440), h = Math.round((m % 1440) / 60);
    return h ? `${d} days ${h} h` : `${d} days`;
  }
  const fromNow = (ms, now) => (ms >= now ? `in ${span(ms - now)}` : `${span(now - ms)} ago`);
  // "in 5 h 12 min" that keeps itself current (see tick); with a window,
  // "happening now" while the window is open.
  function relative(ms, now, from, to) {
    const s = el('span', { 'data-at': ms, 'data-from': from, 'data-to': to });
    s.textContent = relText(s, now);
    return s;
  }
  function relText(s, now) {
    const from = Number(s.dataset.from), to = Number(s.dataset.to);
    return from && now >= from && now <= to ? 'happening now' : fromNow(Number(s.dataset.at), now);
  }

  function duration(s) {
    const m = Math.floor(s / 60), r = Math.round(s % 60);
    return m ? (r ? `${m} min ${r} s` : `${m} min`) : `${r} s`;
  }

  const place = (lat, lon) =>
    `${num(Math.abs(lat), 1)}° ${lat >= 0 ? 'N' : 'S'}, ${num(Math.abs(lon), 1)}° ${lon >= 0 ? 'E' : 'W'}`;

  function days(age) {
    const d = Math.round(age);
    return age < 1 ? 'under a day' : d === 1 ? 'a day' : `${d} days`;
  }

  function groundLight(o, kind) {
    const e = o.sun_elevation_deg;
    if (kind === 'dark') return `Night, sun ${num(-e)}° below the horizon`;
    return e >= 15 ? `Daylight, sun ${num(e)}° up` : `Low sun, ${num(e)}° up`;
  }

  const satelliteLight = {
    sunlit: 'Satellite in sunlight',
    terminator: "Satellite at the edge of the Earth's shadow",
    shadow: "Satellite in the Earth's shadow",
  };

  const accuracyNote = {
    good: 'Times good to a few seconds.',
    fair: 'Times may be off by tens of seconds.',
    rough: 'Times may be off by a minute or more: look again once newer elements arrive.',
  };

  // -- data -----------------------------------------------------------------

  let data = null;
  let filter = 'all';
  try { filter = sessionStorage.getItem('watchlist-filter') || 'all'; } catch { /* storage blocked */ }

  async function load() {
    $('status').textContent = 'Loading the watchlist.';
    $('notes').replaceChildren();
    try {
      const res = await fetch(DATA_URL, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`${res.status}`);
      data = await res.json();
    } catch (err) {
      data = null;
      showMissing(err);
      return;
    }
    render();
  }

  function showMissing(err) {
    $('status').textContent = '';
    $('filters').hidden = true;
    $('list').replaceChildren();
    $('later').hidden = true;
    const box = $('empty');
    box.hidden = false;
    const missing = /^404$/.test(err && err.message);
    box.replaceChildren(
      missing
        ? "There's no watchlist yet. The site's scheduled update makes one about once an hour."
        : "The watchlist didn't load.",
      el('br'),
      el('button', { class: 'btn', type: 'button', text: 'Try again' }),
    );
    box.querySelector('button').addEventListener('click', load);
  }

  // Each event's passes still to come, the next first.
  function upcoming(event, now) {
    return event.opportunities
      .filter((o) => Date.parse(o.window.to) >= now)
      .sort((a, b) => Date.parse(a.closest_at) - Date.parse(b.closest_at));
  }

  function render() {
    const now = Date.now();
    const windowEnd = Date.parse(data.window.to);
    const generated = Date.parse(data.generated_at);
    const tle = Date.parse(data.tle_epoch);

    $('lead').replaceChildren('Things happening on Earth that ', el('span', { class: 'name', text: 'CTS-SAT-1' }),
      ` will pass over in the next ${span(windowEnd - Date.parse(data.window.from))}, in the right light for a picture.`);
    $('status').replaceChildren('Made ', relative(generated, now), `, at ${utc(generated)}. Passes worked out from orbital elements of ${utc(tle)}.`);

    const notes = [];
    if (now - generated > STALE_HOURS * 3600e3) {
      notes.push(el('p', { class: 'ink', text: `This list was made ${span(now - generated)} ago, so newer events and passes are missing.` }));
    }
    for (const s of data.sources) {
      const why = s.error ? ` (${s.error})` : '';
      if (s.status === 'stale' && s.fetched_at) {
        notes.push(el('p', { class: 'ink', text: `${s.name} couldn't be reached at the last update${why}, so its events are as of ${utc(Date.parse(s.fetched_at))}, ${span(now - Date.parse(s.fetched_at))} ago.` }));
      } else if (s.status === 'down') {
        notes.push(el('p', { class: 'ink', text: `${s.name} couldn't be reached${why}, so its events are missing.` }));
      }
    }
    const tleAge = (now - tle) / 86400e3;
    if (tleAge > 7) {
      notes.push(el('p', { class: 'ink', text: `The orbital elements are ${days(tleAge)} old, so pass times may be off by a minute or more.` }));
    }
    $('notes').replaceChildren(...notes);

    const { withPasses, without } = split(now);
    shape = signature(withPasses);

    renderFilters(withPasses, without);
    const shown = (x) => filter === 'all' || x.e.category === filter;

    const list = withPasses.filter(shown);
    $('list').replaceChildren(...list.map(({ e, ops }) => item(e, ops, now)));
    drawMaps();

    const empty = $('empty');
    empty.hidden = list.length > 0;
    if (!list.length) {
      if (!data.events.length) {
        empty.textContent = "Nothing on the watchlist right now: none of the feeds lists an open event big enough to see from orbit.";
      } else if (now > windowEnd) {
        empty.textContent = `Every pass on this list is over: it was made ${span(now - generated)} ago and hasn't been rebuilt since.`;
      } else if (filter === 'all') {
        empty.textContent = `None of these events has a pass close enough, in the right light, before ${calgary(windowEnd)}.`;
      } else {
        empty.textContent = `No ${CATEGORIES[filter] ? CATEGORIES[filter][1].toLowerCase() : 'events'} with a pass before ${calgary(windowEnd)}.`;
      }
    }

    const later = without.filter(shown);
    $('later').hidden = !later.length;
    $('later-lead').textContent = `Open now, but the satellite doesn't come within ${num(data.max_km)} km of them in the right light before ${calgary(windowEnd)}.`;
    $('later-list').replaceChildren(...later.map(({ e }) => el('li', {},
      el('a', { href: e.sources[0] ? e.sources[0].url : null, text: e.title }),
      small(describe(e)),
    )));

    renderHow();
  }

  function split(now) {
    const withPasses = [], without = [];
    for (const e of data.events) {
      const ops = upcoming(e, now);
      (ops.length ? withPasses : without).push({ e, ops });
    }
    withPasses.sort((a, b) => Date.parse(a.ops[0].closest_at) - Date.parse(b.ops[0].closest_at));
    return { withPasses, without };
  }

  // Which passes are listed: when one slips into the past, the list is redrawn.
  let shape = '';
  const signature = (withPasses) => withPasses.map(({ e, ops }) => `${e.id}@${ops.length}`).join(' ');

  function renderFilters(withPasses, without) {
    const counts = new Map();
    for (const { e } of [...withPasses, ...without]) counts.set(e.category, (counts.get(e.category) || 0) + 1);
    const order = Object.keys(CATEGORIES).filter((c) => counts.has(c));
    if (filter !== 'all' && !counts.has(filter)) filter = 'all';
    const box = $('filters');
    box.hidden = order.length < 2;
    const button = (key, label, n) => {
      const b = el('button', { type: 'button', 'aria-pressed': String(filter === key) }, label, el('span', { class: 'n', text: String(n) }));
      b.addEventListener('click', () => {
        filter = key;
        try { sessionStorage.setItem('watchlist-filter', key); } catch { /* storage blocked */ }
        render();
      });
      return b;
    };
    box.replaceChildren(
      button('all', 'All', withPasses.length + without.length),
      ...order.map((c) => button(c, CATEGORIES[c][1], counts.get(c))),
    );
  }

  function describe(e) {
    const kind = CATEGORIES[e.category] ? CATEGORIES[e.category][0] : 'Event';
    if (e.category === 'aurora') return `${e.where}.`;
    const where = e.where || (e.lat != null ? (e.moving ? `last reported at ${place(e.lat, e.lon)}` : place(e.lat, e.lon)) : '');
    return where ? `${kind}, ${where}` : kind;
  }

  // -- one event --------------------------------------------------------------

  function item(e, ops, now) {
    const next = ops[0];
    const best = ops.reduce((a, b) => (b.quality > a.quality ? b : a), next);
    const t = Date.parse(next.closest_at);
    const from = Date.parse(next.window.from), to = Date.parse(next.window.to);

    const meta = el('div', { class: 'meta' }, small(describe(e)));
    const sizeLine = [e.size, e.alert && e.alert !== 'Green' ? `${e.alert} alert from GDACS` : null].filter(Boolean).join('. ');
    if (sizeLine) meta.append(small(sizeLine));
    if (e.updated_at) meta.append(small(`${e.category === 'aurora' ? 'NOAA data as of' : 'Last reported'} ${utc(Date.parse(e.updated_at))}`));

    const facts = el('dl', { class: 'facts' });
    const fact = (label, value, ...notes) => facts.append(el('dt', { text: label }), el('dd', {}, value, ...notes));

    const whenLine = small(`${utc(t)}, `);
    whenLine.append(relative(t, now, from, to));
    fact('Next pass', calgary(t), whenLine);
    if (e.category === 'aurora') {
      fact('Where', `Over the oval at ${num(Math.abs(next.magnetic_latitude_deg))}° magnetic latitude`,
        small(`${place(next.target.lat, next.target.lon)}, for ${duration((to - from) / 1000)}`));
      fact('Activity', `Kp ${num(next.kp, 1)} forecast for then`, small(`The list waits for Kp ${num(data.rules.aurora_kp, 1)} or more.`));
    } else {
      fact('How close', `${num(next.distance_km)} km from the point below the satellite`,
        small(`${num(next.off_nadir_deg)}° off straight down, within ${num(data.max_km)} km for ${duration((to - from) / 1000)}`));
      if (next.target.projected_h) {
        const h = next.target.projected_h;
        const around = `Around ${place(next.target.lat, next.target.lon)}.`;
        if (next.target.basis === 'forecast') {
          fact('Position', `On its forecast track, ${num(h)} h after the last report`, small(around));
        } else {
          fact('Position', `Where its recent track points, ${num(h)} h after the last report`,
            small(h > 24 ? `${around} That is a long way past the last report: check the source before planning.` : around, h > 24 ? 'ink' : ''));
        }
      }
    }
    fact('Light', groundLight(next, e.light), small(satelliteLight[next.satellite.light] || ''));
    fact('Accuracy', `Orbital elements ${days(next.tle_age_days)} old by then`, small(accuracyNote[next.accuracy] || '', next.accuracy === 'rough' ? 'ink' : ''));
    if (best !== next) {
      const bt = Date.parse(best.closest_at);
      fact('Best pass', calgary(bt), small(passSummary(best, e)));
    }

    const links = el('div', { class: 'links' },
      el('a', { href: `${ORBIT_URL}#t=${next.closest_at}`, text: 'Show on the Orbit page' }));
    const seen = new Map();
    for (const s of e.sources) {
      const n = (seen.get(s.name) || 0) + 1;
      seen.set(s.name, n);
      links.append(el('a', { href: s.url, rel: 'noopener', text: n > 1 ? `${s.name}, report ${n}` : s.name }));
    }

    const body = el('div', { class: 'body' },
      el('div', {}, el('h2', { text: e.title }), meta),
      facts,
      links);

    if (ops.length > 1) {
      const rest = ops.slice(1);
      body.append(el('details', { class: 'more' },
        el('summary', { text: rest.length === 1 ? '1 more pass' : `${rest.length} more passes` }),
        el('ol', { class: 'passes' }, rest.map((o) => {
          const ot = Date.parse(o.closest_at);
          const line = small(`${utc(ot)}, `);
          line.append(relative(ot, now));
          return el('li', {},
            el('span', { text: calgary(ot) }),
            el('span', { text: passSummary(o, e) }),
            line);
        }))));
    }

    const canvas = el('canvas', { role: 'img', 'aria-label': mapLabel(e, next) });
    const map = el('div', { class: 'map' }, canvas);
    canvas._map = { e, o: next };
    return el('li', { class: 'item' }, map, body);
  }

  function passSummary(o, e) {
    const light = e.light === 'dark' ? `sun ${num(-o.sun_elevation_deg)}° below` : `sun ${num(o.sun_elevation_deg)}° up`;
    return o.distance_km == null ? `Kp ${num(o.kp, 1)}, ${light}` : `${num(o.distance_km)} km away, ${light}`;
  }

  function mapLabel(e, o) {
    if (e.category === 'aurora') return `Map: the satellite's ground track across the auroral oval near ${place(o.target.lat, o.target.lon)}.`;
    return `Map: the satellite's ground track passing ${num(o.distance_km)} km from ${e.title} at ${place(o.target.lat, o.target.lon)}.`;
  }

  // -- maps -------------------------------------------------------------------
  // An equirectangular crop of NASA's Blue Marble (Black Marble for night
  // events), the ground track in the team blue and the event as a square.

  const textures = {};
  function texture(kind) {
    if (!textures[kind]) {
      const img = new Image();
      img.decoding = 'async';
      img.src = kind === 'dark' ? 'earth-night.jpg' : 'earth-day.jpg';
      textures[kind] = new Promise((resolve) => {
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
      });
    }
    return textures[kind];
  }

  const observer = 'IntersectionObserver' in window
    ? new IntersectionObserver((entries) => {
      for (const x of entries) {
        if (x.isIntersecting) { observer.unobserve(x.target); draw(x.target); }
      }
    }, { rootMargin: '400px 0px' })
    : null;

  function drawMaps() {
    for (const c of document.querySelectorAll('.map canvas')) {
      if (observer) observer.observe(c); else draw(c);
    }
  }

  async function draw(canvas) {
    const { e, o } = canvas._map;
    const img = await texture(e.light);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.fillStyle = '#05070A';
    ctx.fillRect(0, 0, w, h);

    const lat0 = Math.max(-78, Math.min(78, o.target.lat));
    const lon0 = o.target.lon;
    const latSpan = 22;
    const lonSpan = Math.min(360, (latSpan * w) / h / Math.max(Math.cos((lat0 * Math.PI) / 180), 0.2));
    const x = (lon) => ((wrap(lon - lon0) + lonSpan / 2) / lonSpan) * w;
    const y = (lat) => ((lat0 + latSpan / 2 - lat) / latSpan) * h;

    if (img) {
      const worldW = (360 / lonSpan) * w, worldH = (180 / latSpan) * h;
      const left = ((-180 - lon0 + lonSpan / 2) / lonSpan) * w;
      const top = y(90);
      ctx.imageSmoothingQuality = 'high';
      for (const k of [-1, 0, 1]) ctx.drawImage(img, left + k * worldW, top, worldW, worldH);
    }

    // the ground track: one 2px line, broken where it wraps round the map
    ctx.strokeStyle = '#3C9DF5';
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let prev = null;
    for (const [la, lo] of o.ground_track) {
      const px = x(lo), py = y(la);
      if (prev && Math.abs(px - prev) < w) ctx.lineTo(px, py); else ctx.moveTo(px, py);
      prev = px;
    }
    ctx.stroke();

    if (e.category !== 'aurora') {
      const px = Math.round(x(o.target.lon)), py = Math.round(y(o.target.lat));
      ctx.lineWidth = 4;
      ctx.strokeStyle = '#05070A';
      ctx.strokeRect(px - 6, py - 6, 12, 12);
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#E6EBF0';
      ctx.strokeRect(px - 6, py - 6, 12, 12);
    }
  }

  const wrap = (d) => ((((d + 180) % 360) + 360) % 360) - 180;

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { for (const c of document.querySelectorAll('.map canvas')) draw(c); }, 150);
  });

  // -- the method, from the file's own numbers --------------------------------

  function renderHow() {
    const r = data.rules;
    const aurora = data.aurora;
    const paras = [
      'A scheduled job, with no person or AI in the loop, collects open events from public feeds about once an hour and works out from the satellite\'s orbital elements when the ground below it next comes close to each one.',
      `A pass counts when the point directly below CTS-SAT-1 comes within ${num(data.max_km)} km of the event. The camera's footprint isn't documented, so that distance is a guess: a lens like the Raspberry Pi camera's would see about 300 km either side of straight down from 500 km up.`,
      `The light has to be right too: for most events the sun at least ${num(r.day_sun_min_deg)}° up where the event is, and for aurora the ground at least ${num(-r.dark_sun_max_deg)}° past sunset. Aurora is listed when NOAA forecasts Kp ${num(r.aurora_kp, 1)} or more, and a pass counts when the satellite crosses the oval in the dark while it lasts.`,
      `Wildfires smaller than ${num(r.min_fire_ha)} hectares and prescribed burns are left out, and so are earthquakes and droughts, which can't be seen from orbit. Storms move: they're placed along their forecast track where GDACS publishes one, or carried on along their recent track for up to a day, and no further.`,
      'Times come from the newest orbital elements. The older those are by the time of a pass, the less exact its time: a day or two old is good to a few seconds, a week old can be off by a minute or more.',
    ];
    if (aurora && aurora.max_kp != null && aurora.max_kp < aurora.threshold_kp) {
      paras.splice(3, 0, `No aurora on the list at the moment: NOAA's highest Kp forecast in this window is ${num(aurora.max_kp, 1)}, under the ${num(aurora.threshold_kp, 1)} the list waits for.`);
    }
    $('how').replaceChildren(...paras.map((t) => el('p', { text: t })));
  }

  // Passes slip into the past while the page is open: keep the "in 5 h"
  // times current, and redraw the list only when a pass drops off it (so
  // an open "more passes" list stays open).
  function tick() {
    if (!data) return;
    const now = Date.now();
    if (signature(split(now).withPasses) !== shape) { render(); return; }
    for (const s of document.querySelectorAll('[data-at]')) s.textContent = relText(s, now);
  }
  setInterval(tick, 30e3);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });

  if (location.protocol === 'file:') {
    $('status').textContent = 'Open this page through a web server (python -m http.server in the site folder); browsers block data files on file:// pages.';
  } else {
    load();
  }
})();
