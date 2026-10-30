// Credits: a dialog over whichever page is open, so opening it never leaves
// the page. Used by the main site, the Orbit page and the watchlist page:
//
//   import { mountCredits } from '<site>/assets/credits.js';
//   const credits = mountCredits(document.querySelector('#credits'));
//   credits.open();  // also opened by clicking the button
//
// The text is fixed here; the "In the news" list comes from explore/facts.json
// and is loaded the first time the dialog opens.

const SITE = new URL('../', import.meta.url);

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
  dialog.innerHTML = `
    <div class="credits-head">
      <h2 class="credits-title" id="credits-title" tabindex="-1">Credits</h2>
      <button type="button" class="credits-close" data-close>Close</button>
    </div>
    <img class="credits-logo" src="${logo}" width="640" height="204" alt="CalgaryToSpace">
    <ul class="credits-links">
      <li><a href="https://www.calgarytospace.ca/">calgarytospace.ca</a></li>
      <li><a href="https://frontiersat.mooo.com/">FrontierSat dashboard</a>, live beacon data</li>
      <li><a href="https://github.com/CalgaryToSpace">github.com/CalgaryToSpace</a></li>
    </ul>
    <p class="credits-made">Website designed by Jonathan Eng and <span>Claude <span aria-hidden="true">🛰️</span></span></p>
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
      <p>CubeSat model: NASA IceCube, a 3U like CTS-SAT-1, by NASA/Christopher R. Meaney (NASA 3D Resources,
        public domain); drawn far larger than life.</p>
    </section>
    <div class="credits-news"></div>`;
  return dialog;
}

export function mountCredits(button) {
  ensureStyles();
  const dialog = build();
  document.body.append(dialog);
  let newsLoaded = false;

  async function loadNews() {
    if (newsLoaded) return;
    newsLoaded = true;
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

  function open() {
    if (dialog.open) return;
    const page = document.documentElement;
    page.classList.toggle('credits-gutter', window.innerWidth > page.clientWidth);
    page.classList.add('credits-open');
    dialog.showModal();
    button?.setAttribute('aria-expanded', 'true');
    dialog.querySelector('.credits-title').focus({ preventScroll: true });
    loadNews();
  }

  // the close event can come a good while after a busy frame, so the page isn't left waiting on it
  function freePage() {
    document.documentElement.classList.remove('credits-open', 'credits-gutter');
  }

  function close() {
    if (!dialog.open) return;
    dialog.close();
    freePage();
  }

  dialog.querySelector('[data-close]').addEventListener('click', close);
  // keys pressed in the pop-up are its own: the page's shortcuts (the Orbit
  // page's Space and arrows, a picture's Previous/Next) don't see them
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
    button?.focus({ preventScroll: true });
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
  return { open, close, dialog };
}
