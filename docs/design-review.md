# Design review

Reviews against `docs/design-direction.md`. Newest checkpoint first. Findings are ranked by impact,
each with a concrete fix. "Lead" marks a fix in a file the catalogue builder doesn't own.

---

## Checkpoint 1: the catalogue (29 Oct 2026)

Page: http://localhost:8000/dev/catalogue.html (`site/assets/catalogue.js`, `catalogue.css`,
`filters.js`), data built 30 Oct 04:12 UTC (30 pictures, 7 marked `dark`).

**What I looked at.**

- Sizes: 1440 × 900 and 375 × 812 in my own browser tab; 1440, 375 and 2560 in `inspect.mjs`
  (the inspector's 2560 frame is 2560 × 1600, so at 2560 × 1440 the empty band below is about 160px
  shorter than in its screenshots).
- States: One; Two (Alberta + 6 Aug); Four (with an attitude-camera partial and a cut-short frame);
  a partial picture (4 Aug); a cut-short picture (25 Oct); the newest (30 Oct, cut short, 4% shown);
  filters open at 1440 and 375; dark frames.

**Measured.** `inspect.mjs --app` gives 0 FAIL in all three modes. Warnings:

- `hero-void` at 2560: 33% of the first screen is one empty block. This is finding 3.
- `no-data-hue` at 2560: a false positive; the screen has no chart.

Sizes in use are 13 / 14 / 15 / 16 / 20 / 32. The 14 is the mono `<code>`; 14 and 15 also come from
the old nav in `style.css`. Typefaces are Jost 94% and Plex Mono 6% (only the file name and
sha256). `lint.mjs --app` gives 0 FAIL; its 5 warnings are false positives (the word "shadow" in
copy, and `backdrop-filter: none`).

**Answers to the app-screen questions** (skill `app-screens.md` §2.7):

1. **Is the biggest thing the answer?** Yes for a whole picture. But the default view opens on a
   picture that is 96% flat grey, so the biggest thing on the first screen says nothing (finding 2).
2. **Shared edges?** One: yes. Two: there's a 206px hole under the captions. Four: captions start
   80px left of their pictures (finding 4). At 2560 the lower half of the screen is empty
   (finding 3).
3. **Colour only on data?** Yes. Ink inversion is used for the selected segment and the primary;
   the blue appears only on focus. The nav's blue underline comes from the old `style.css` (lead).
4. **Do the numbers agree?** No. The count says "30 pictures" while the strip holds 23, and the 7
   dark frames can't be reached (finding 1).
5. **Zeros and missing values honest?** Mostly. The newest frame's copy hides that most of it is
   still missing, and its Check line reads as corruption (finding 2).
6. **Legend and marks?** In compare mode, every compared thumbnail carries the same full bar, so
   the active cell's picture can't be told apart (finding 7).
7. **Phone?** Good. The order is picture, controls, strip, then facts, with 44px controls. Two
   problems: the search field is 23px tall, and the selects are 40px (finding 5).

### Findings, by impact

**1. The dark frames can't be reached, and the count is wrong. (Bug)**

- `data.js` `applyFilters` now drops dark frames unless `dark=1` (line 281). So the catalogue's
  `matched` never contains them, `darkN` is 0, and the "Show them" item is never rendered. I checked
  the DOM at 1440 and 375: there is no `.cat-strip-end` and no dark toggle.
- The strip holds 23 thumbnails while the dock says "30 pictures".
- Even when it renders, the toggle sits after the oldest thumbnail, at the far end of a strip that
  scrolls sideways. It is off-screen at every width.

Fix:

- In `render()`, use `matched = applyFilters(photos, { ...filters, dark: '1' })`, as `gallery.js`
  does. Keep the catalogue's own `showDark` split.
- Count from `shown`.
- Move the control out of the strip and into the dock row, right after the count, in Small. Use the
  gallery's words so the site says it one way: "23 pictures. 7 dark frames hidden: nothing but
  black, sensor noise or the Sun as a single dot." followed by the text button "Show them" (then
  "Hide them").
- With filters set: "12 of 23 pictures. 2 dark frames hidden."

**2. The catalogue opens on a grey box, and that picture's copy undersells what's missing.**

With no `id`, it opens on the newest picture, `2026-10-30-024400z`. Only 3.8% of it can be shown,
so the stage at 1440, 375 and 2560 is a 640 × 480 slab of #808080 with a sliver of cloud on top.

Fixes:

- **Default selection.** With no `id` in the URL, open the newest picture that is not dark and has
  `completeness ≥ 0.5` (today: Alberta, 24 Oct). The strip still starts with the newest, grey
  thumbnail included, so nothing is hidden. Deep links still open any picture.
- **Status line** for truncated files with lines missing. Today it says only "it saved lines 0–499
  of 1210". Build it from `status_note` and `completeness`:
  "The satellite stopped this capture early and saved lines 0–499 of 1210. 367 of those have come
  down so far, but a gap near the top means only the top 4% can be shown."
- **Still coming down.** When the last packet is under 24 h old, add "Still coming down: last
  packet 1 h ago." The direction's state applies to any picture with lines missing, not only
  `partial`.
- **Check fact.** "Doesn't match the satellite's checksum" reads as corruption. When lines are
  missing, use "Can't check yet" with the second line "Part of the file hasn't come down."

**3. At 2560 the lower half of the screen is empty, and the page ground changes colour under it.**

At 2560 the composition ends about 1005px down (2560 × 1600), so 37% of the screen below it is
empty. At 2560 × 1440 the empty band is still about 430px. Below the `.cat` block the body ground
#090C10 shows under the catalogue's #05070A: two grounds. The same band is visible along the
bottom 15px at 1440.

Fixes:

- **On tall, wide screens** (`@media (min-width: 1800px) and (min-height: 1100px)`): let the dock
  span both columns (`grid-template-areas: "viewer info" "dock dock"`; the info column is shorter
  than the stage there). Wrap the strip into a contact sheet: `.cat-strip { flex-wrap: wrap;
  overflow: visible; row-gap: 8px }`, with `--thumb-h: 96px`. All 23 frames then sit under the
  picture in two or three rows, which fills the void with the pictures themselves.
- **`.cat { min-height: calc(100svh - var(--nav-h)) }`** so the catalogue's ground reaches the
  bottom.
- **Lead:** switch `style.css` to the direction's tokens (`--bg` becomes #05070A) so there is one
  ground.

**4. Two and Four don't use One's stage; Two leaves a hole and Four pillarboxes.**

- Two at 1440: the cells are 468 × 351, but the viewer keeps One's 602px height. That leaves a 206px
  hole between the captions and the dock.
- Four at 1440: each cell is a 468 × 230 Panel mat with a 307 × 230 picture centred in it. That
  draws Panel bars on both sides of every picture, like letterboxed video, and the captions start
  at the mat's edge, 80px left of their picture.
- At 2560 Four is right (four pictures at 1×). The ADCS frame is drawn at 480 instead of 512,
  which is fine.

Fix: one rule for all three modes. The stage (Panel, the viewer's full size, the same height in
One, Two and Four, so the dock never moves) holds the pictures centred as a group at ≤1×. Each
caption sits directly under its own picture and starts at that picture's left edge. No per-cell
mats.

- Remove `background` and `aspect-ratio` from `.cat-cell-pick`.
- Give `.cat-compare` `background: var(--c-panel); padding: 24px; display: grid;
  grid-template-columns: repeat(2, auto); place-content: center; gap: 16px 24px`.
- Size each `img` with `max-width: min(640px, 100%)` and `max-height: var(--cell-h)`, where:
  - Two: `--cell-h: calc(var(--view-h) - 48px - 62px)`
  - Four: `--cell-h: calc((var(--view-h) - 48px - 16px) / 2 - 62px)`
- `.cat-cell` becomes `display: grid; justify-items: start`, so the caption takes its picture's
  left edge.
- Captions stay Ink and Muted on Panel (Muted is 6.1:1 there).
- An empty cell is a 4:3 box in Raised (#1A2129) so it reads on the Panel stage, with the same
  sentence.

**5. The filters push the strip off the screen, use pipeline words, and their fields are short.**

- **The fold.** At 1440 × 900, opening Filters adds a 72px row and the strip drops to about 840px,
  half below the fold. Fix: while the filters are open, the stage gives up the row's height:
  `.cat:has(.cat-filter-toggle[aria-expanded="true"]) { --dock-h: 262px; }`, or a class set in
  `setFiltersOpen`.
- **Labels.** The options use pipeline words: "PiCAM", "ADCS", "verified", "complete", "partial",
  "cut short on board". Use the same words as the facts: "Main camera", "Attitude camera";
  "Checked", "Complete, unchecked", "Partly missing", "Cut short on board".
- **Empty filters.** Hide Member and Tag until they have options. The disabled "No names yet" and
  "No tags yet" selects are noise to the public.
- **Search field.** It measures 23px tall at 375, so the 40px rule isn't winning against the
  `style.css` `.search input` rule. Set `height: var(--ctl-h)` with enough specificity, and give
  the selects `height: var(--ctl-h)` as well (they are 40px today; touch needs 44).

**6. Line breaks inside ranges and dates; jargon in the partial line.**

- At 1440 and 2560 the status line breaks inside a range ("lines 0–" on one line, "499" on the
  next).
- "Came down" breaks inside a date ("…to 25" on one line, "Oct 00:14 UTC" on the next).
- Fix: wrap every date, time and range in `<span class="cat-nobr">` (`white-space: nowrap`), so
  lines break only at " to " and after commas.
- The partial line says "the camera's JPEG can't be read past the first gap". Write instead: "Part
  of this picture never came down. Nothing below the first gap can be read, so only the top 19% is
  shown."

**7. In compare mode the strip doesn't show which picture is in the active cell.**

- Every compared thumbnail carries the same 3px Ink bar. Fix: the active cell's picture keeps the
  full bar; the other compared pictures get the bar at 40% (`--c-under`). There is no hover bar in
  compare mode.
- On the phone in Two, the active bar sits 12px above the next picture and reads as a divider.
  Fix: `.cat-compare { gap: 24px }` under 600px.

**8. The actions wrap raggedly.**

At 1440 and 2560 the five actions wrap into two rows, with "All details" alone on the second. Fix:
put the primary "Show on the globe" on its own line, then one row of text buttons with 20px gaps:
Compare, Download, Copy link, All details (about 330px, which fits the 400px column).

**9. Lead: the nav still comes from the old `style.css`.**

The nav has a 1px hairline under the header, a 1px divider beside the wordmark, 14px links, and the
team blue underline on the current page. Blue is reserved for the orbit and focus rings. The
ground is #090C10. Fix in `style.css` per direction §2:

- one ground, #05070A;
- links in Body 16/500;
- a 2px Ink underline for the current page;
- no hairline, no divider.

### The builder's deviations

- **Strip and controls under the picture column only: accept.** At 1440 × 900 the facts column is
  taller than the stage (it ends about 840px down), so a full-width dock would fall below the
  fold. The exception is tall, wide screens, where the dock spans both columns as a contact sheet
  (finding 3).
- **Filters behind "Filters (n)": accept.** It keeps the dock to one quiet row. Fix how it opens
  (finding 5).
- **Pictures on a dark mat, never above 1×: accept.** The mat does a real job: night frames (Johor,
  22 Oct) and frames with black edges keep their outline against the Panel tone. Keep it, and make
  it the one stage for One, Two and Four (finding 4). This replaces the direction's "as large as
  fits"; I'll update §4 to say "at most 1×, centred on a Panel stage".
- **Compare state in the query: accept.** `#/pictures?id=…&compare=a,b` is shareable and works
  with back and forward. Keep `id` equal to the active cell, as it is now.

### Keep

- The true-black-flat execution: no borders, rules or shadows; the selected segment and the primary
  by Ink inversion.
- Jost with tabular figures, and Mono only in the file name and hash.
- The facts with their "From the file name" and "Worked out from orbital elements" second lines.
- The disabled "Show on the globe" for date-only pictures, with its reason.
- The month labels in the strip.
- The phone order, and the 44px controls.
