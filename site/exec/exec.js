/**
 * exec/: the executives' page. Signed in with their own GitHub accounts, they choose which
 * pictures take turns in the viewfinder (the live view, a TV, Orbit's Pictures panel), and
 * every change is logged: who, when, what went in or out, and an optional note.
 *
 * The live site is static (GitHub Pages), so GitHub does the checking and the saving:
 *   - Signing in takes an access key from the executive's own GitHub account. The page asks
 *     GitHub who that is and whether the account can change the site's repository
 *     (config.js repoUrl); only then does it go on.
 *   - Saving commits site/data/carousel.json (assets/carousel.js, docs/DATA.md) to the
 *     repository as that account. The push starts .github/workflows/publish.yml, which
 *     publishes the site, and the page watches for the change to go live.
 *   - The log is inside carousel.json, so it is published with the choices and saved in the
 *     same commit; the repository's history on GitHub keeps each commit under the account that
 *     made it.
 *
 * The key is kept in this tab (sessionStorage), or on this device (localStorage) when asked
 * to, and is sent only to api.github.com; the page's Content-Security-Policy allows no other
 * host. Styles: exec.css, class prefix `ex-`.
 */
import { h, announce } from '../assets/dom.js';
import { mergeAll } from '../assets/data.js';
import { clock, monthDayYear, percent, plural, toDate } from '../assets/format.js';
import { CALGARY_TIME_ZONE, CALGARY_ZONE_NAME } from '../assets/calgary-clock.js';
import {
  CAROUSEL_PATH,
  CAROUSEL_URL,
  changeChoices,
  choicesText,
  isNearlyWhole,
  readChoices,
} from '../assets/carousel.js';

const API = 'https://api.github.com';
const KEY_NAME = 'cts-exec-github-key';
const LOG_SHOWN = 15; // entries before "Show older"
const NOTE_MAX = 300;
const WATCH_MS = 20 * 1000; // between looks at the published file after a save
const WATCH_FOR_MS = 20 * 60 * 1000;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

const main = document.getElementById('main');
const whoEl = document.getElementById('who');

const repoMatch = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/
  .exec(String(window.CTS1_CONFIG?.repoUrl || ''));
const REPO = repoMatch ? { owner: repoMatch[1], name: repoMatch[2] } : null;
const repoPath = REPO ? `/repos/${REPO.owner}/${REPO.name}` : '';
const NEW_KEY_URL = 'https://github.com/settings/tokens/new?description=FrontierSat%20carousel&scopes=public_repo';

// ---- state -------------------------------------------------------------------------------
let token = '';
let user = null; // GitHub's /user: { login, name, html_url }
let branch = 'main';
let photos = []; // mergeAll() output, newest first
let byId = new Map();
let remote = { sha: null, choices: readChoices(null) }; // carousel.json as GitHub last gave it
const wants = new Map(); // unsaved: id -> true (in) | false (out)
let filter = 'all';
let logOpen = false;
let saving = false;
let watchTimer = 0;
let ui = null; // the signed-in view's parts

// ---- the access key ----------------------------------------------------------------------
const stores = () => {
  const out = [];
  try { out.push(window.sessionStorage); } catch { /* blocked */ }
  try { out.push(window.localStorage); } catch { /* blocked */ }
  return out;
};
const savedKey = {
  get() {
    for (const s of stores()) {
      try { const v = s.getItem(KEY_NAME); if (v) return v; } catch { /* blocked */ }
    }
    return '';
  },
  set(value, keep) {
    this.clear();
    const [session, local] = [(() => { try { return window.sessionStorage; } catch { return null; } })(),
      (() => { try { return window.localStorage; } catch { return null; } })()];
    try { (keep ? local : session)?.setItem(KEY_NAME, value); } catch { /* not remembered */ }
  },
  clear() {
    for (const s of stores()) {
      try { s.removeItem(KEY_NAME); } catch { /* blocked */ }
    }
  },
};

// ---- GitHub ------------------------------------------------------------------------------
class GitHubError extends Error {
  constructor(status, message, headers) {
    super(message || `GitHub answered ${status}`);
    this.status = status;
    this.headers = headers;
  }
}

async function gh(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(API + path, {
      method,
      cache: 'no-store',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new GitHubError(0, 'network');
  }
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  if (!res.ok) throw new GitHubError(res.status, json?.message || '', res.headers);
  return { json, headers: res.headers };
}

/** What went wrong, in words for the person at the keyboard. */
function trouble(err, doing) {
  if (err.status === 0) return `Couldn’t reach GitHub, so ${doing}. Check the connection and try again.`;
  if (err.status === 401) return 'GitHub didn’t accept that access key. Check that you copied all of it and that it hasn’t expired.';
  if (err.status === 403 && err.headers?.get('x-ratelimit-remaining') === '0') {
    return `GitHub is turning away requests for a few minutes, so ${doing}. Try again shortly.`;
  }
  if (err.status === 403 || err.status === 404) {
    return `GitHub didn’t let this access key do that, so ${doing}. Make a new key with public_repo ticked (the link under “How to get an access key”).`;
  }
  return `GitHub answered “${err.message}” (${err.status}), so ${doing}.`;
}

const fromBase64 = (b64) => new TextDecoder().decode(Uint8Array.from(atob(String(b64).replace(/\s/g, '')), (c) => c.charCodeAt(0)));
function toBase64(text) {
  let bin = '';
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** carousel.json as it is in the repository now (not as last published). */
async function readRemote() {
  try {
    const { json } = await gh(`${repoPath}/contents/${CAROUSEL_PATH}?ref=${encodeURIComponent(branch)}`);
    let parsed;
    try {
      parsed = JSON.parse(fromBase64(json.content));
    } catch {
      throw new Error(`${CAROUSEL_PATH} in the repository isn’t valid JSON, so nothing can be saved over it. Fix or restore it on GitHub first.`);
    }
    remote = { sha: json.sha, choices: readChoices(parsed) };
  } catch (err) {
    if (err.status !== 404) throw err;
    remote = { sha: null, choices: readChoices(null) }; // not made yet: the first save makes it
  }
}

// ---- pictures ----------------------------------------------------------------------------
async function loadPhotos() {
  const json = async (url) => {
    const res = await fetch(new URL(url, location.href), { cache: 'no-cache' });
    if (!res.ok) throw new Error(`${res.status} for ${url}`);
    return res.json();
  };
  const [images, anns] = await Promise.all([
    json('../data/images.json'),
    json('../data/annotations.json').catch(() => ({})),
  ]);
  const list = Array.isArray(images?.images) ? images.images.filter((i) => i && typeof i.id === 'string' && i.id) : [];
  photos = mergeAll(list, anns && typeof anns === 'object' && !Array.isArray(anns) ? anns : {});
  byId = new Map(photos.map((p) => [p.id, p]));
}

const renamed = (p) => p.title && p.title !== p.defaultTitle;
const nameOf = (p) => (renamed(p) ? p.title : p.place || p.computedPlace || p.title || p.id);
const whenOf = (p) => {
  const d = toDate(p.capturedAt);
  return d ? `${monthDayYear(d)}, ${clock(d)} UTC` : null;
};
/** "Alberta, Canada (Nov 15, 2026, 17:41 UTC)", for the log. */
function pictureLabel(id) {
  const p = byId.get(id);
  if (!p) return id;
  const name = nameOf(p);
  const when = whenOf(p);
  return when && name !== when ? `${name} (${when})` : name;
}

const placedNow = (p) => (remote.choices.remove.includes(p.id) ? false
  : remote.choices.add.includes(p.id) ? true : isNearlyWhole(p));
const shownAs = (p) => (wants.has(p.id) ? wants.get(p.id) : placedNow(p));

let calgaryFormat = null;
function calgaryHm(d) {
  try {
    calgaryFormat ||= new Intl.DateTimeFormat('en-US', {
      timeZone: CALGARY_TIME_ZONE, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    const parts = {};
    for (const part of calgaryFormat.formatToParts(d)) parts[part.type] = part.value;
    return `${parts.month} ${parts.day}, ${parts.hour}:${parts.minute} ${CALGARY_ZONE_NAME}`;
  } catch {
    return null;
  }
}

// ---- views -------------------------------------------------------------------------------
function showWho() {
  if (!user) {
    whoEl.hidden = true;
    whoEl.replaceChildren();
    return;
  }
  whoEl.hidden = false;
  whoEl.replaceChildren(
    h('span', { class: 'ex-who-name' }, user.name ? `${user.name} (@${user.login})` : `@${user.login}`),
    h('button', { type: 'button', class: 'ex-link-btn', onclick: signOut }, 'Sign out'),
  );
}

function message(text, { retry } = {}) {
  main.replaceChildren(h('section', { class: 'ex-signin' },
    h('p', { class: 'ex-error', role: 'alert' }, text),
    retry ? h('button', { type: 'button', class: 'ex-btn', onclick: retry }, 'Try again') : null));
}

function renderSignIn(error = '') {
  ui = null;
  showWho();
  const keyInput = h('input', {
    id: 'ex-key', class: 'ex-input', type: 'password', name: 'key', autocomplete: 'off',
    spellcheck: 'false', autocapitalize: 'off', required: true,
  });
  const keep = h('input', { type: 'checkbox', id: 'ex-keep' });
  const errorEl = h('p', { class: 'ex-error', role: 'alert' }, error);
  const button = h('button', { type: 'submit', class: 'ex-btn ex-btn-main' }, 'Sign in');
  const form = h('form', { class: 'ex-form', novalidate: true },
    h('label', { class: 'ex-label', for: 'ex-key' }, 'GitHub access key'),
    keyInput,
    h('label', { class: 'ex-keep' }, keep, ' Keep me signed in on this device'),
    button,
    errorEl);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const key = keyInput.value.trim();
    if (!key) {
      errorEl.textContent = 'Paste your GitHub access key first.';
      keyInput.focus();
      return;
    }
    button.disabled = true;
    button.textContent = 'Signing in…';
    errorEl.textContent = '';
    const problem = await signIn(key, keep.checked);
    if (problem) {
      button.disabled = false;
      button.textContent = 'Sign in';
      errorEl.textContent = problem;
      keyInput.select();
    }
  });

  const repoName = `${REPO.owner}/${REPO.name}`;
  main.replaceChildren(h('section', { class: 'ex-signin' },
    h('h1', { class: 'ex-title' }, 'Executive sign-in'),
    h('p', { class: 'ex-lede' },
      'Choose which pictures take turns in the live view, on the TV and on Orbit. Sign in with an access key from your own GitHub account: only accounts that can change the site’s repository can save, and each change is logged under the account that made it.'),
    form,
    h('details', { class: 'ex-help' },
      h('summary', null, 'How to get an access key'),
      h('ol', null,
        h('li', null, `Your GitHub account needs to be a collaborator on ${repoName}. If it isn’t yet, ask the site’s owner to add it, then accept the invitation GitHub emails you.`),
        h('li', null, 'Open ',
          h('a', { href: NEW_KEY_URL, target: '_blank', rel: 'noopener noreferrer' }, 'GitHub’s page for a new access key'),
          '. It opens with only public_repo ticked, which is all this page needs. Choose when the key should expire, then press Generate token.'),
        h('li', null, 'Copy the key (it starts with ghp_) and paste it above. GitHub shows it only once.')),
      h('p', null,
        'The key stays in this browser and is sent only to GitHub. Sign out to forget it here; to stop it working anywhere, delete it on GitHub under Settings → Developer settings → Personal access tokens.'))));
  keyInput.focus();
}

/** Checks the key with GitHub and opens the page; returns what went wrong, or '' once signed in. */
async function signIn(key, keep) {
  token = key;
  try {
    const { json: me, headers } = await gh('/user');
    const { json: repo } = await gh(repoPath);
    if (!me?.login || !LOGIN.test(me.login)) throw new GitHubError(500, 'GitHub didn’t say who this is');
    if (!repo?.permissions?.push) {
      token = '';
      return `That key belongs to @${me.login}, which can’t change ${REPO.owner}/${REPO.name} yet. Ask the site’s owner to add it as a collaborator, accept the invitation GitHub emails you, then sign in again.`;
    }
    // a classic key says what it may do; it needs public_repo (or repo) to save
    const scopes = headers.get('x-oauth-scopes');
    if (scopes != null) {
      const list = scopes.split(',').map((s) => s.trim());
      if (!list.includes('repo') && !(repo.private === false && list.includes('public_repo'))) {
        token = '';
        return `That key belongs to @${me.login} but can only read. Make a new one with public_repo ticked (the link under “How to get an access key”).`;
      }
    }
    user = { login: me.login, name: typeof me.name === 'string' ? me.name.trim().slice(0, 100) : '' };
    branch = typeof repo.default_branch === 'string' && repo.default_branch ? repo.default_branch : 'main';
    await readRemote();
    savedKey.set(token, keep);
    renderMain();
    announce(`Signed in as ${user.login}.`);
    return '';
  } catch (err) {
    token = '';
    user = null;
    if (err instanceof GitHubError) return trouble(err, 'you’re not signed in');
    return err.message || 'Something went wrong while signing in.';
  }
}

function signOut() {
  if (wants.size && !window.confirm(`Sign out without saving ${plural(wants.size, 'change')}?`)) return;
  window.clearTimeout(watchTimer);
  savedKey.clear();
  token = '';
  user = null;
  wants.clear();
  remote = { sha: null, choices: readChoices(null) };
  renderSignIn();
  announce('Signed out.');
}

function renderMain() {
  showWho();
  const count = h('p', { class: 'ex-count' });
  const filters = h('div', { class: 'ex-filters', role: 'group', 'aria-label': 'Show' });
  const grid = h('ul', { class: 'ex-grid' });
  const note = h('input', {
    class: 'ex-input ex-note', type: 'text', maxlength: String(NOTE_MAX),
    placeholder: 'Note for the log (optional)', 'aria-label': 'Note for the log (optional)',
  });
  const barText = h('p', { class: 'ex-bar-text' });
  const undo = h('button', { type: 'button', class: 'ex-btn', onclick: undoAll }, 'Undo changes');
  const saveBtn = h('button', { type: 'button', class: 'ex-btn ex-btn-main', onclick: save }, 'Save');
  const changes = h('div', { class: 'ex-bar-row', hidden: true },
    h('div', { class: 'ex-bar-words' }, barText, h('p', { class: 'ex-bar-sub' }, 'Saving puts it on the live site.')),
    note, h('div', { class: 'ex-bar-buttons' }, undo, saveBtn));
  // what the last save did, and whether it's live yet
  const status = h('p', { class: 'ex-status', role: 'status' });
  const live = h('p', { class: 'ex-live' });
  const dismiss = h('button', { type: 'button', class: 'ex-link-btn', onclick: clearStatus }, 'Dismiss');
  const news = h('div', { class: 'ex-bar-row ex-bar-news', hidden: true },
    h('div', { class: 'ex-bar-words' }, status, live), dismiss);
  const bar = h('div', { class: 'ex-bar', hidden: true }, h('div', { class: 'ex-bar-inner' }, news, changes));
  const log = h('section', { class: 'ex-log', 'aria-labelledby': 'ex-log-title' });

  ui = { count, filters, grid, note, bar, changes, news, dismiss, barText, undo, saveBtn, status, live, log, cards: new Map() };

  main.replaceChildren(
    h('section', { class: 'ex-head' },
      h('h1', { class: 'ex-title' }, 'Carousel pictures'),
      h('p', { class: 'ex-lede' },
        'Ticked pictures take turns in the live view, on the TV and in Orbit’s Pictures panel, newest first. A new picture joins by itself once at least 95% of it has come down. Untick one to take it out, or tick any other picture to add it.'),
      count, filters),
    grid,
    log,
    bar);

  for (const p of photos) {
    const box = h('input', { type: 'checkbox', class: 'ex-check' });
    box.checked = shownAs(p);
    box.addEventListener('change', () => choose(p, box.checked));
    const tags = h('span', { class: 'ex-tags' });
    const c = Number(p.raw?.completeness);
    const card = h('li', { class: 'ex-card', dataset: { id: p.id } },
      h('label', { class: 'ex-pick' },
        h('span', { class: 'ex-thumb' },
          h('img', { src: `../${p.thumb}`, alt: '', loading: 'lazy', decoding: 'async', width: '320', height: '240' }),
          box),
        h('span', { class: 'ex-card-body' },
          h('span', { class: 'ex-name' }, nameOf(p)),
          h('span', { class: 'ex-when' }, whenOf(p) && whenOf(p) !== nameOf(p) ? whenOf(p) : (p.capturedAt ? '' : 'Time unknown')),
          h('span', { class: 'ex-meta' }, p.dark ? 'Dark frame' : Number.isFinite(c) ? `${percent(c)} came down` : ''),
          tags)));
    ui.cards.set(p.id, { card, box, tags });
    grid.append(card);
  }
  paint();
}

function choose(p, on) {
  if (on === placedNow(p)) wants.delete(p.id);
  else wants.set(p.id, on);
  paint();
}

function undoAll() {
  wants.clear();
  paint();
  announce('Changes undone.');
}

function paint() {
  if (!ui) return;
  let inCount = 0;
  for (const p of photos) {
    const { card, box, tags } = ui.cards.get(p.id);
    const on = shownAs(p);
    if (on) inCount += 1;
    box.checked = on;
    const rule = isNearlyWhole(p);
    const list = [];
    if (on && !rule) list.push(h('span', { class: 'ex-tag is-added' }, 'Added by hand'));
    if (!on && rule) list.push(h('span', { class: 'ex-tag is-out' }, 'Taken out by hand'));
    if (wants.has(p.id)) list.push(h('span', { class: 'ex-tag is-unsaved' }, 'Not saved yet'));
    tags.replaceChildren(...list);
    card.classList.toggle('is-in', on);
    card.classList.toggle('is-unsaved', wants.has(p.id));
    card.hidden = filter === 'in' ? !on : filter === 'out' ? on : false;
  }
  ui.count.replaceChildren(h('strong', null, `${inCount} of ${plural(photos.length, 'picture')}`), ' in the carousel.');

  const counts = { all: photos.length, in: inCount, out: photos.length - inCount };
  ui.filters.replaceChildren(...[['all', 'All'], ['in', 'In the carousel'], ['out', 'Left out']].map(([key, label]) =>
    h('button', {
      type: 'button', class: 'ex-filter', 'aria-pressed': String(filter === key),
      onclick: () => { filter = key; paint(); },
    }, `${label} (${counts[key]})`)));

  const hasNews = Boolean(ui.status.textContent || ui.live.textContent);
  ui.changes.hidden = !wants.size;
  ui.news.hidden = !hasNews;
  ui.dismiss.hidden = saving;
  ui.bar.hidden = !wants.size && !hasNews;
  document.body.classList.toggle('has-bar', !ui.bar.hidden);
  ui.barText.textContent = `${plural(wants.size, 'change')} not saved`;
  ui.saveBtn.disabled = saving;
  ui.undo.disabled = saving;
  ui.saveBtn.textContent = saving ? 'Saving…' : 'Save';
  paintLog();
}

function paintLog() {
  const entries = remote.choices.log;
  const title = h('h2', { class: 'ex-log-title', id: 'ex-log-title' }, 'Who changed what');
  const history = REPO ? h('a', {
    href: `https://github.com/${REPO.owner}/${REPO.name}/commits/${encodeURIComponent(branch)}/${CAROUSEL_PATH}`,
    target: '_blank', rel: 'noopener noreferrer',
  }, 'every commit on GitHub') : null;
  const foot = h('p', { class: 'ex-log-foot' },
    'Each change is also a commit in the repository under the account that made it: ', history, '.');
  if (!entries.length) {
    ui.log.replaceChildren(title,
      h('p', { class: 'ex-log-empty' }, 'No changes yet. Until someone changes it, the carousel is every picture at least 95% complete.'),
      foot);
    return;
  }
  const shown = logOpen ? entries : entries.slice(0, LOG_SHOWN);
  const items = shown.map((e) => {
    const login = typeof e.by === 'string' && LOGIN.test(e.by) ? e.by : null;
    const name = typeof e.name === 'string' ? e.name.slice(0, 100) : '';
    const at = toDate(e.at);
    const ids = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
    const added = ids(e.added);
    const removed = ids(e.removed);
    return h('li', { class: 'ex-log-item' },
      h('p', { class: 'ex-log-who' },
        login ? h('a', { href: `https://github.com/${login}`, target: '_blank', rel: 'noopener noreferrer' }, `@${login}`) : 'Someone',
        name ? ` (${name})` : '',
        at ? h('span', { class: 'ex-log-when' }, ` · ${monthDayYear(at)}, ${clock(at)} UTC`, calgaryHm(at) ? ` (${calgaryHm(at)})` : '') : null),
      added.length ? h('p', { class: 'ex-log-what' }, h('span', { class: 'ex-log-verb is-added' }, 'Added '), added.map(pictureLabel).join('; ')) : null,
      removed.length ? h('p', { class: 'ex-log-what' }, h('span', { class: 'ex-log-verb is-out' }, 'Took out '), removed.map(pictureLabel).join('; ')) : null,
      typeof e.note === 'string' && e.note ? h('p', { class: 'ex-log-note' }, `“${e.note.slice(0, NOTE_MAX)}”`) : null);
  });
  const more = entries.length > LOG_SHOWN
    ? h('button', { type: 'button', class: 'ex-link-btn', onclick: () => { logOpen = !logOpen; paintLog(); } },
      logOpen ? 'Show fewer' : `Show ${plural(entries.length - LOG_SHOWN, 'older change')}`)
    : null;
  ui.log.replaceChildren(...[title, h('ol', { class: 'ex-log-list' }, items), more, foot].filter(Boolean));
}

function setStatus(text, { error = false } = {}) {
  ui.status.textContent = text;
  ui.status.classList.toggle('is-error', error);
  ui.status.setAttribute('role', error ? 'alert' : 'status');
}

function clearStatus() {
  window.clearTimeout(watchTimer);
  ui.status.textContent = '';
  ui.live.textContent = '';
  paint();
}

// ---- saving ------------------------------------------------------------------------------
function commitMessage(entry) {
  const parts = [];
  if (entry.added.length) parts.push(`added ${plural(entry.added.length, 'picture')}`);
  if (entry.removed.length) parts.push(`took out ${plural(entry.removed.length, 'picture')}`);
  const lines = [`Carousel: @${entry.by} ${parts.join(', ')}`, ''];
  if (entry.added.length) lines.push(`Added: ${entry.added.map(pictureLabel).join('; ')}`);
  if (entry.removed.length) lines.push(`Took out: ${entry.removed.map(pictureLabel).join('; ')}`);
  if (entry.note) lines.push(`Note: ${entry.note}`);
  lines.push('', 'Saved from the executives’ page (exec/).');
  return lines.join('\n');
}

async function save() {
  if (saving || !wants.size || !user) return;
  saving = true;
  window.clearTimeout(watchTimer);
  ui.live.textContent = '';
  setStatus('Saving…');
  paint();
  const note = ui.note.value.trim().replace(/\s+/g, ' ').slice(0, NOTE_MAX);
  try {
    let done = null;
    for (let attempt = 0; attempt < 3 && !done; attempt += 1) {
      // someone else saved since this page read the file: build on theirs
      if (attempt) await readRemote();
      const { choices, added, removed } = changeChoices(remote.choices, wants, byId);
      if (!added.length && !removed.length) {
        done = { nothing: true };
        break;
      }
      const entry = {
        at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        by: user.login,
        ...(user.name ? { name: user.name } : {}),
        added,
        removed,
        ...(note ? { note } : {}),
      };
      const next = { ...choices, log: [entry, ...choices.log] };
      try {
        const { json } = await gh(`${repoPath}/contents/${CAROUSEL_PATH}`, {
          method: 'PUT',
          body: {
            message: commitMessage(entry),
            content: toBase64(choicesText(next)),
            branch,
            ...(remote.sha ? { sha: remote.sha } : {}),
          },
        });
        remote = { sha: json?.content?.sha || null, choices: readChoices(next) };
        done = { entry };
      } catch (err) {
        if (err.status === 409 || (err.status === 422 && /sha/i.test(err.message))) continue;
        throw err;
      }
    }
    saving = false;
    if (!done) {
      setStatus('Someone else saved at the same moment, three times over, so this wasn’t saved. Try again.', { error: true });
    } else if (done.nothing) {
      wants.clear();
      ui.note.value = '';
      setStatus('Nothing to save: the carousel already looks like this.');
    } else {
      wants.clear();
      ui.note.value = '';
      const n = done.entry.added.length + done.entry.removed.length;
      setStatus(`Saved ${plural(n, 'change')} as @${user.login}. The site and the TV show it once GitHub publishes it, usually within 5 minutes.`);
      announce('Saved.');
      watchLive(done.entry);
    }
  } catch (err) {
    saving = false;
    if (err.status === 401) {
      savedKey.clear();
      setStatus('GitHub no longer accepts this access key (it may have expired), so nothing was saved. Sign out and sign in with a new one.', { error: true });
    } else {
      setStatus(err instanceof GitHubError ? trouble(err, 'nothing was saved') : (err.message || 'Nothing was saved.'), { error: true });
    }
  }
  paint();
}

/** After a save: looks at the published file until the change is in it. */
function watchLive(entry) {
  const started = Date.now();
  ui.live.textContent = 'Waiting for GitHub to publish it…';
  const look = async () => {
    if (!ui) return;
    try {
      const res = await fetch(new URL(`../${CAROUSEL_URL}`, location.href), { cache: 'no-store' });
      const published = readChoices(res.ok ? await res.json() : null);
      if (published.log.some((e) => e.at === entry.at && e.by === entry.by)) {
        ui.live.textContent = 'Live: the site now shows this change. A TV picks it up within 10 minutes.';
        return;
      }
    } catch { /* look again */ }
    if (Date.now() - started > WATCH_FOR_MS) {
      ui.live.replaceChildren('It’s saved, but GitHub hasn’t published it after 20 minutes. ',
        h('a', { href: `https://github.com/${REPO.owner}/${REPO.name}/actions`, target: '_blank', rel: 'noopener noreferrer' }, 'See GitHub’s publishing runs'), '.');
      return;
    }
    watchTimer = window.setTimeout(look, WATCH_MS);
  };
  watchTimer = window.setTimeout(look, WATCH_MS);
}

window.addEventListener('beforeunload', (event) => {
  if (!wants.size) return;
  event.preventDefault();
  event.returnValue = '';
});

// ---- start -------------------------------------------------------------------------------
async function start() {
  if (!REPO) {
    message('This copy of the site has no GitHub repository set (repoUrl in config.js), so there’s nowhere to save choices.');
    return;
  }
  try {
    await loadPhotos();
  } catch (err) {
    console.warn('Executives: no picture list', err);
    message('The picture list didn’t load.', { retry: start });
    return;
  }
  const key = savedKey.get();
  if (!key) {
    renderSignIn();
    return;
  }
  main.replaceChildren(h('p', { class: 'ex-loading' }, 'Signing in…'));
  const problem = await signIn(key, (() => { try { return Boolean(window.localStorage.getItem(KEY_NAME)); } catch { return false; } })());
  if (problem) {
    // a key GitHub turned down is forgotten; one that couldn't be checked (offline) is kept
    if (!/Couldn’t reach GitHub|turning away/.test(problem)) savedKey.clear();
    renderSignIn(problem);
  }
}

start();
