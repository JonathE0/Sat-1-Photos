// Credits: a dialog over whichever page is open, so opening it never leaves
// the page. Used by the main site, the Orbit page and the watchlist page:
//
//   import { mountCredits } from '<site>/assets/credits.js';
//   const credits = mountCredits(document.querySelector('#credits'));
//   credits.open();  // also opened by clicking the button
//   credits.open({ show: 'news', from: someButton });  // at the "In the news" list; focus goes back to someButton
//
// It also gives the nav a "More" menu for phones (mountMore below): About and Credits
// move into it there, so the links left are big enough to tap.
//
// The text is fixed here; the "In the news" list comes from explore/facts.json
// and is loaded the first time the dialog opens. "Last updated" comes from
// data/updated.json, fetched again each time it opens.

import { calgary, plural, toDate } from './format.js';

const SITE = new URL('../', import.meta.url);

// "just now", "12 minutes ago", "3 hours ago", "2 days ago"
function ago(ms) {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return 'just now'; // also a viewer whose clock runs a little behind
  if (minutes < 60) return `${plural(minutes, 'minute')} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${plural(hours, 'hour')} ago`;
  return `${plural(Math.floor(hours / 24), 'day')} ago`;
}

function ensureStyles() {
  for (const href of ['assets/credits.css', 'explore/facts.css']) {
    const url = new URL(href, SITE).href;
    if ([...document.styleSheets].some((s) => s.href === url)) continue;
    if (document.querySelector(`link[data-credits-css="${href}"]`)) continue;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = url;
    link.dataset.creditsCss = href;
    document.head.append(link);
  }
}

function build() {
  const dialog = document.createElement('dialog');
  dialog.className = 'credits';
  dialog.setAttribute('aria-labelledby', 'credits-title');
  const logo = new URL('assets/calgarytospace-logo.png', SITE).href;
  const schulich = new URL('assets/schulich-logo.png', SITE).href;
  dialog.innerHTML = `
    <div class="credits-head">
      <h2 class="credits-title" id="credits-title" tabindex="-1">Credits</h2>
      <button type="button" class="credits-close" data-close>Close</button>
    </div>
    <div class="credits-logos">
      <img class="credits-logo" src="${logo}" width="640" height="204" alt="CalgaryToSpace">
      <img class="credits-logo credits-partner" src="${schulich}" width="277" height="144"
        alt="Schulich School of Engineering, University of Calgary">
    </div>
    <ul class="credits-links">
      <li><a href="https://www.calgarytospace.ca/">calgarytospace.ca</a></li>
      <li><a href="https://frontiersat.mooo.com/">FrontierSat dashboard</a>, live beacon data</li>
      <li><a href="https://github.com/CalgaryToSpace">github.com/CalgaryToSpace</a></li>
      <li><a href="https://github.com/JonathE0/Sat-1-Photos">github.com/JonathE0/Sat-1-Photos</a>, this site and all its pictures</li>
    </ul>
    <p class="credits-made">Website designed by Jonathan Eng and <span>Claude <span aria-hidden="true">🛰️</span></span></p>
    <p class="credits-updated" hidden>Last updated <time></time></p>
    <section class="credits-section">
      <h3>Thank you</h3>
      <p>To the mission operations team, who do a great job of keeping FrontierSat running and getting its
        pictures down to Earth. None of this would be possible without them.</p>
      <p>That thanks extends to the whole CalgaryToSpace team, whose work designing, building and testing the
        satellite put it in orbit in the first place.</p>
    </section>
    <section class="credits-section">
      <h3>Sources</h3>
      <p>Earth: NASA Blue Marble, Black Marble and cloud imagery. Orbital elements:
        <a href="https://www.space-track.org/">Space-Track.org</a>. Packets: the
        <a href="https://network.satnogs.org/">SatNOGS network</a> and the team's own ground station.
        Place names: © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>.
        Country borders: <a href="https://www.naturalearthdata.com/">Natural Earth</a> (public domain).</p>
      <p>Sky: the <a href="http://tdc-www.harvard.edu/catalogs/bsc5.html">Yale Bright Star Catalogue</a>
        (Hoffleit and Warren, 1991) and the Moon from NASA's Scientific Visualization Studio
        (<a href="https://svs.gsfc.nasa.gov/4720">CGI Moon Kit</a>).</p>
      <p>Satellite model: CalgaryToSpace's own CAD of FrontierSat (the V11 frame), outside only and
        simplified for the web, with the sun sensors, magnetometer and UHF antenna as their makers' CAD
        draws them (CubeSpace, ISISPACE); drawn far larger than life.</p>
    </section>
    <div class="credits-news"></div>`;
  return dialog;
}

export function mountCredits(button) {
  ensureStyles();
  const dialog = build();
  document.body.append(dialog);
  let newsLoading = null;
  let returnTo = button; // where focus goes when it closes

  function loadNews() {
    newsLoading ||= fetchNews();
    return newsLoading;
  }

  async function fetchNews() {
    try {
      const [{ createNewsList }, res] = await Promise.all([
        import(new URL('explore/facts.js', SITE).href),
        fetch(new URL('explore/facts.json', SITE).href, { cache: 'no-cache' }),
      ]);
      const data = res.ok ? await res.json() : null;
      if (Array.isArray(data?.news) && data.news.length) {
        createNewsList(dialog.querySelector('.credits-news'), { news: data.news });
      }
    } catch (err) {
      console.warn('Credits: no news list', err); // the credits themselves still show
    }
  }

  const updatedLine = dialog.querySelector('.credits-updated');
  const updatedTime = updatedLine.querySelector('time');
  let updatedAt = null;
  let ticking = 0;

  function showUpdated() {
    if (!updatedAt) return;
    updatedTime.textContent = ago(Date.now() - updatedAt.getTime());
    updatedTime.dateTime = updatedAt.toISOString();
    updatedTime.title = calgary(updatedAt) || '';
    updatedLine.hidden = false;
  }

  async function loadUpdated() {
    try {
      const res = await fetch(new URL('data/updated.json', SITE).href, { cache: 'no-cache' });
      const at = res.ok ? toDate((await res.json())?.updated_at) : null;
      if (at) {
        updatedAt = at;
        showUpdated();
      }
    } catch {
      // no stamp yet (a copy of the site no update has run on): the line stays hidden
    }
  }

  // The "In the news" list, scrolled to the top of the dialog with focus on its heading.
  function showNews() {
    const section = dialog.querySelector('.credits-news > *');
    if (!dialog.open || !section) return;
    const head = dialog.querySelector('.credits-head');
    const top = section.getBoundingClientRect().top - dialog.getBoundingClientRect().top + dialog.scrollTop;
    dialog.scrollTop = Math.max(0, top - head.offsetHeight - 8);
    const heading = section.querySelector('h2, h3') || section;
    heading.tabIndex = -1;
    heading.style.outline = 'none';
    heading.focus({ preventScroll: true });
  }

  function open({ show = null, from = null } = {}) {
    if (dialog.open) return;
    returnTo = from || button;
    const page = document.documentElement;
    page.classList.toggle('credits-gutter', window.innerWidth > page.clientWidth);
    page.classList.add('credits-open');
    dialog.showModal();
    button?.setAttribute('aria-expanded', 'true');
    dialog.querySelector('.credits-title').focus({ preventScroll: true });
    const news = loadNews();
    if (show === 'news') news.then(showNews);
    showUpdated(); // the last answer straight away, then a fresh one
    loadUpdated();
    clearInterval(ticking);
    ticking = setInterval(showUpdated, 30 * 1000);
  }

  // the close event can come a good while after a busy frame, so the page isn't left waiting on it
  function freePage() {
    document.documentElement.classList.remove('credits-open', 'credits-gutter');
    clearInterval(ticking);
  }

  function close() {
    if (!dialog.open) return;
    dialog.close();
    freePage();
  }

  dialog.querySelector('[data-close]').addEventListener('click', close);
  // keys pressed in the pop-up are its own: the page's shortcuts (the Orbit
  // page's Space and arrows, a picture's Newer/Older) don't see them
  dialog.addEventListener('keydown', (e) => e.stopPropagation());
  // a click on the dimmed backdrop (the dialog element itself, outside its box) closes it
  dialog.addEventListener('click', (e) => {
    if (e.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) close();
  });
  // Escape closes a modal dialog natively; either way, hand focus back
  dialog.addEventListener('close', () => {
    if (dialog.open) return; // delivered a frame late: it was opened again meanwhile
    freePage();
    button?.setAttribute('aria-expanded', 'false');
    (returnTo && returnTo.isConnected && returnTo.getClientRects().length ? returnTo : button)?.focus({ preventScroll: true });
    returnTo = button;
  });
  // the browser's Back, or any move to another page of the site, takes it away
  window.addEventListener('popstate', close);
  window.addEventListener('hashchange', close);

  if (button) {
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-expanded', 'false');
    button.addEventListener('click', (e) => {
      e.preventDefault();
      if (dialog.open) close();
      else open();
    });
  }
  mountMore(button, open);
  return { open, close, dialog };
}

/* The nav's "More" menu, for phones (assets/nav.css): About and Credits go into it */

let moreCount = 0;

function mountMore(credits, openCredits) {
  const links = credits?.closest('.nav-links');
  if (!links || links.querySelector('.nav-more')) return;
  const about = [...links.children].find((el) => el.tagName === 'A' && /#\/about$/.test(el.getAttribute('href') || ''));
  const id = `nav-more-${++moreCount}`;

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'nav-btn nav-more-btn';
  toggle.textContent = 'More';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', id);

  const menu = document.createElement('div');
  menu.className = 'nav-more-menu';
  menu.id = id;
  menu.hidden = true;
  if (about) {
    // the same link; on the main site its data-nav keeps it marked on About (app.js)
    const copy = about.cloneNode(true);
    copy.classList.remove('nav-in-more');
    menu.append(copy);
    about.classList.add('nav-in-more');
  }
  const creditsItem = document.createElement('button');
  creditsItem.type = 'button';
  creditsItem.textContent = 'Credits';
  creditsItem.setAttribute('aria-haspopup', 'dialog');
  menu.append(creditsItem);
  credits.classList.add('nav-in-more');

  const wrap = document.createElement('div');
  wrap.className = 'nav-more';
  wrap.append(toggle, menu);
  credits.after(wrap);
  links.classList.add('has-more');

  const setOpen = (open, focusToggle = false) => {
    menu.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (focusToggle) toggle.focus({ preventScroll: true });
  };
  toggle.addEventListener('click', () => setOpen(menu.hidden));
  creditsItem.addEventListener('click', () => {
    setOpen(false);
    openCredits({ from: toggle });
  });
  menu.addEventListener('click', (e) => { if (e.target.closest('a')) setOpen(false); });
  wrap.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false, true);
    }
  });
  wrap.addEventListener('focusout', (e) => { if (!menu.hidden && !wrap.contains(e.relatedTarget)) setOpen(false); });
  document.addEventListener('pointerdown', (e) => { if (!menu.hidden && !wrap.contains(e.target)) setOpen(false); });
  window.addEventListener('hashchange', () => setOpen(false));
  // wider than a phone the menu isn't shown, so it can't be left open there
  window.addEventListener('resize', () => { if (!menu.hidden && !toggle.getClientRects().length) setOpen(false); });
}
