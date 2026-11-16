// The carousel: the pictures that take turns in the viewfinder, in the live view (and on a
// TV, tv/), at the end of the home page's story on big screens, and in Orbit's Pictures panel.
//
// By default that is every picture at least 95% there that isn't a dark frame
// (isNearlyWhole), so a new picture joins by itself. The team's executives change it on
// exec/, signed in with their own GitHub accounts; their choices are site/data/carousel.json
// (docs/DATA.md):
//   add     ids shown although the rule would leave them out
//   remove  ids left out although the rule would show them (an id in both is left out)
//   log     who changed what, newest first
// No file, or one that doesn't read, leaves the rule as it is.
//
// No imports: exec/ and Node's checks (globe/fixtures/verify.mjs) load this without three.js.

export const CAROUSEL_PATH = 'site/data/carousel.json'; // in the repository
export const CAROUSEL_URL = 'data/carousel.json'; // from the site's root

/** Not a dark frame, and at least 95% of the picture can be shown. */
export const isNearlyWhole = (photo) => !photo.dark && !((photo.raw?.completeness ?? photo.completeness) < 0.95);

const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const idList = (v) => (Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === 'string' && x))] : []);

/** The choices in carousel.json, checked: { add, remove, log }. Anything else reads as no choices. */
export function readChoices(json) {
  const o = isObject(json) ? json : {};
  const remove = idList(o.remove);
  const out = new Set(remove);
  return {
    add: idList(o.add).filter((id) => !out.has(id)),
    remove,
    log: Array.isArray(o.log) ? o.log.filter(isObject) : [],
  };
}

/** Marks each picture in or out (photo.carousel = true | false) and returns the list. */
export function applyChoices(photos, choices) {
  const add = new Set(choices?.add || []);
  const remove = new Set(choices?.remove || []);
  for (const p of photos) p.carousel = remove.has(p.id) ? false : add.has(p.id) ? true : isNearlyWhole(p);
  return photos;
}

/** In the carousel: as applyChoices marked it, else by the rule. */
export const inCarousel = (photo) => (typeof photo.carousel === 'boolean' ? photo.carousel : isNearlyWhole(photo));

/** The published choices, from the site at siteRoot (a URL, or a path from this page); none if they don't load. */
export async function loadChoices(siteRoot = '') {
  try {
    const res = await fetch(new URL(CAROUSEL_URL, new URL(siteRoot || './', document.baseURI)), { cache: 'no-cache' });
    return readChoices(res.ok ? await res.json() : null);
  } catch {
    return readChoices(null);
  }
}

/**
 * The choices after putting some pictures in or out. wants: Map of id -> true (in) or false (out);
 * byId: the pictures by id, for the rule (a picture not in it counts as one the rule leaves out).
 * Returns { choices, added, removed }, the last two the ids whose place really changed. A picture
 * set back to what the rule says leaves both lists, so it follows the rule again.
 */
export function changeChoices(current, wants, byId) {
  const add = new Set(current.add);
  const remove = new Set(current.remove);
  const rule = (id) => (byId.has(id) ? isNearlyWhole(byId.get(id)) : false);
  const placed = (id) => (remove.has(id) ? false : add.has(id) ? true : rule(id));
  const added = [];
  const removed = [];
  for (const [id, want] of wants) {
    const was = placed(id);
    add.delete(id);
    remove.delete(id);
    if (want !== rule(id)) (want ? add : remove).add(id);
    if (want && !was) added.push(id);
    if (!want && was) removed.push(id);
  }
  const sorted = (set) => [...set].sort();
  return { choices: { add: sorted(add), remove: sorted(remove), log: current.log }, added, removed };
}

/** carousel.json's text: two-space JSON, ending in a newline, like the site's other data files. */
export function choicesText(choices) {
  return `${JSON.stringify({ add: choices.add, remove: choices.remove, log: choices.log }, null, 2)}\n`;
}
