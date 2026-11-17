// The sponsors, for Credits' row (credits.js) and Explore's strip in the corner's row (explore/journey.js),
// and the choice between that strip and the row's controls, made in Credits.

const SITE = new URL('../', import.meta.url);

// The team's sponsors, in the order the team's shirt prints them: [file in assets/sponsors/, name,
// the logo's width and height as shown, and for two of them a line under the logo]. Ten are on
// calgarytospace.ca/sponsorships; the shirt adds ABB, Calian, Valley Metal, Siemens NX, Garmin,
// ESA's Fly Your Satellite! and Lockheed Martin, and Ansys came after it. They pass by in a row
// under "Thank you" in Credits (credits.js), and in Explore's corner row when chosen there (explore/journey.js).
// A file is a PNG unless its name says otherwise.
// ESA allows only its own logo, with none for a programme (brand.esa.int), so the programme
// is written under it; Siemens has no NX logo of its own either.
export const SPONSORS = [
  ['ucalgary', 'University of Calgary', 170, 52],
  ['schulich', 'Schulich School of Engineering', 101, 52],
  ['hexagon-novatel', 'Hexagon | NovAtel', 190, 37],
  ['abb', 'ABB', 131, 52],
  ['mda-space', 'MDA Space', 140, 52],
  ['helium', 'Helium', 148, 52],
  ['calian', 'Calian', 190, 51],
  ['valley-metal', 'Valley Metal', 140, 48],
  ['siemens', 'Siemens NX', 144, 28, 'NX'],
  ['garmin', 'Garmin', 190, 52],
  ['altium', 'Altium', 190, 48],
  ['esa', 'ESA Fly Your Satellite!', 83, 32, 'Fly Your Satellite!'],
  ['skyfox-labs', 'SkyFox Labs', 84, 52],
  ['minds-in-motion', 'Minds in Motion', 118, 52],
  ['roots-2-stem', 'Roots 2 STEM', 132, 52],
  ['solidworks', 'SolidWorks', 190, 46],
  ['lockheed-martin', 'Lockheed Martin', 190, 29],
  ['ansys.svg', 'Ansys, part of Synopsys', 96, 52],
];
/** How fast Credits' row passes, px a second: however many sponsors there are, it moves the same. */
const SPONSOR_SPEED = 43;

/** A sponsor's logo file, as a URL. */
export const sponsorSrc = (file) => new URL(`assets/sponsors/${file.includes('.') ? file : `${file}.png`}`, SITE).href;

/** How long one set takes to pass, s: at Credits' size each logo, its tile's padding either side (16 px)
    and the gap after it (12 px). A row drawn smaller with the same time shows as many logos a second. */
export const sponsorLoopSeconds = (list) => Math.round(list.reduce((sum, [, , w]) => sum + w + 32 + 12, 0) / SPONSOR_SPEED);

/**
 * Whether Explore's bottom-right row shows the sponsors instead of its controls: chosen in Credits
 * (credits.js), shown by Explore (explore/journey.js), kept for this tab (reloads too). `available`
 * is Explore saying its row can show them here (a wide enough screen); Credits offers it only then.
 */
const ROW_KEY = 'cts-sponsors-row';
const rowListeners = new Set();
let rowOn = false;
try {
  rowOn = sessionStorage.getItem(ROW_KEY) === '1';
} catch { /* no storage: the controls */ }
export const sponsorsRow = {
  available: false,
  get on() { return rowOn; },
  set(on) {
    rowOn = on;
    try {
      if (on) sessionStorage.setItem(ROW_KEY, '1');
      else sessionStorage.removeItem(ROW_KEY);
    } catch { /* for this page only */ }
    for (const fn of rowListeners) fn(on);
  },
  listen(fn) {
    rowListeners.add(fn);
    return () => rowListeners.delete(fn);
  },
};
