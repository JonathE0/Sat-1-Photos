# Design direction: landing globe, status panel, catalogue

Pass 1, 29 Oct 2026. Owner: design lead. Builders follow this file; `docs/design-review.md`
checks the pages against it. The user's decisions (dark, minimal, Jost, the team blue as the only
accent, the three-beat scroll story, realistic Earth, 3U model, status panel, pins, catalogue with
filmstrip and compare, reduced-motion and phone behaviour) are fixed. Everything below works
inside them.

Never type a count, altitude or date into the markup: compute it from `site/data/images.json`,
`tle.json` and the clock. (Today the data holds 29 pictures, 13 of them with a known time.)

---

## 1. The subject and the idea

### What only this satellite has

1. **The name.** CTS-SAT-1, also called FrontierSat. Calgary To Space's first satellite, a 3U
   CubeSat (10 × 10 × 34 cm) built by University of Calgary students. NORAD 69015.
2. **The date.** Launched 3 May 2026.
3. **The orbit.** About 500 km up (498–526 km in the data), 7.6 km a second, once round the Earth
   every 95 minutes, at 97.4° inclination: it passes over both poles (one picture is of Antarctica).
4. **Home.** Calgary, 51° N, 114° W. The globe already computes the next pass over Calgary. On
   24 Oct 2026 at 17:37 UTC it photographed its own province: "Alberta, Canada".
5. **Its pictures.** 640 × 480 main-camera frames with a lavender-blue cast; 512 × 512
   attitude-camera frames. Clouds, open sea, the curve of the Earth with a thin blue atmosphere
   (6 Aug), city lights at night (Johor, 22 Oct), sun glare streaks (17 Sep), a black frame with
   one point of light (attitude camera).
6. **The grey.** Where data never arrived, the file is flat grey (#808080). Some captures were cut
   short on board ("lines 0–249 of the 775 the camera announced").
7. **How a picture comes down.** Hundreds to over a thousand radio packets of about 195 bytes,
   heard by volunteer SatNOGS ground stations, often over several passes, then checked against the
   sha256 the satellite reported.
8. **Light.** For each placed picture we know whether the ground below and the satellite itself
   were in sunlight.
9. **Two clocks.** UTC, and Calgary time (MDT/MST).
10. **The team's blue** #3C9DF5 and the white CalgaryToSpace logo.

### The idea

> On this page, **the ground directly beneath CTS-SAT-1** becomes **the camera's destination and
> the pin**. The story starts on Calgary and ends looking down past the satellite at the patch of
> Earth it is over right now, framed the way its own camera frames the world (black sky, the thin
> blue edge of the atmosphere, ground below, as in its 6 Aug picture). Every picture sits on the
> ground it was over when it was taken, and each pin is that picture.

Competitor test: another CubeSat tracker has a globe, but not a story that starts on Calgary,
pins that are the satellite's own frames, or an end frame copied from its own photograph. The
specific parts (Calgary, its pictures as pins, the 6 Aug framing, the next pass over Calgary, the
honest grey) are what make it this satellite's page. Keep them; they are not decoration.

**The live thing:** the satellite now. Where it is, how high, how fast, when it is next over
Calgary, and the last picture it sent, all one click away from the satellite itself.

### What the skill dealt, and what I took

- Page draw (`draw.mjs`, sector culture, `--keep palette,type`) dealt `contact-sheet` and
  `dense-tiles`. The landing composition is fixed by the user, so I took only the contact sheet,
  for the filmstrip and the closing strip: every picture, small, in order, one text size.
- App draw (`draw.mjs --app`, dark) dealt **true-black-flat** (seed 1607211657) for the catalogue and
  the status panel: separation by lightness alone (no borders, no shadows), the primary control
  made primary by inversion (ink fill, dark text), colour only on data. Its one data hue is the
  team blue.
- From the other skills I take only what agrees with this: label above field, `min-height: 100svh`
  rather than `100vh`, no "scroll to explore", no custom cursor, transform and opacity only, 44px
  touch targets, two-line headlines.
- Deliberately ignored: `minimalist-ui` (warm bone ground, 1px #EAEAEA boxes, pastel pill tags,
  bento grids, fake OS window chrome; it is a light editorial look and wrong for space);
  `high-end-visual-design` (glass, double-bezel cards, eyebrow pills, floating pill nav, blur-in
  reveals; these are the tells this file exists to remove); `gpt-taste` (centred cinematic hero
  with a radial wash, picsum images, "static is forbidden" hover-zoom on everything); `stitch` and
  `v1` (perpetual micro-loops, spring physics on everything, "never pure black", swapping the
  typeface for Geist or Satoshi).

---

## 2. Tokens

### Colour: one ground, one ink, one accent

| Name | Hex | Role | Contrast on Space |
| --- | --- | --- | --- |
| Space | `#05070A` | The only page ground, everywhere, and the 3D scene's clear colour | |
| Panel | `#10151B` | One step up: status panel, segmented-control track, loading blocks, hover card, empty compare cell | |
| Raised | `#1A2129` | Two steps up: hover on a control, loading bars inside the panel | |
| Ink | `#E6EBF0` | All text including the display line; primary button fill | 16.8:1 |
| Muted | `#8A96A3` | Secondary text only (labels, captions, meta) | 6.7:1 (6.1 on Panel) |
| Team blue | `#3C9DF5` | **CTS-SAT-1's orbit line, and the focus ring. Nothing else.** | 7.0:1 |

- Retire `--bg #090C10`, `--stage`, `--bright`, `--hair`, `--rule`, `--field`, `--empty` and the
  globe's `--cg-*` greys and its orange `#FF4F00`. Link underlines at rest: Ink at 40%
  (`color-mix(in srgb, var(--ink) 40%, transparent)`), full Ink on hover.
- The blue means "the satellite's path through space". Not on buttons, not on the current nav
  item, not on selected states, not on headings. Under 2% of any screen.
- #808080 is not a UI colour. It is what partial files contain where data never arrived. Never use
  it in the interface, never repaint it in a picture.
- No gradients, no glows, no shadows. The one allowed scrim: flat Space at 55% behind a text block
  on a phone, only if the Earth would otherwise sit under the words.

### Type: keep Jost

Keep Jost. It is an open revival of Futura, the face on the plaque Apollo 11 left on the Moon and
the face of 1960s spaceflight print, so it belongs to this subject; and it has real tabular figures
(measured in the browser: "0000" and "1111" both 232px wide at 100px with `tabular-nums`), so live
numbers can sit in it without jitter.

**IBM Plex Mono, narrowed** (a refinement of the user's choice; the lead may reverse it): only for
strings someone would copy or compare character by character: file names, sha256, NORAD ID, TLE
lines, each marked up as `<code>` (the inspector accepts mono there and fails it anywhere else).
Times and coordinates move to Jost with `font-variant-numeric: tabular-nums`. Mono as the
"technical voice" for times is the commonest tell of generated space pages. If the user wants mono
for times kept, use it only in the catalogue's facts values, never in captions, pins, the story,
the clock or the panel's headline lines.

Load Jost 400, 500, 600, 700 and Plex Mono 400. Drop 800.

Five sizes, far apart:

| Role | Size (desktop / phone) | Weight | Leading | Tracking | Used for |
| --- | --- | --- | --- | --- | --- |
| Display | `clamp(60px, 10vw, 144px)` | 700 | 0.9 | -0.03em | "CTS-SAT-1", the landing's h1, nowhere else |
| Statement | `clamp(24px, 1rem + 1.2vw, 32px)` | 500 | 1.2 | -0.01em | Story lines, landing h2, catalogue h1 (the picture's place) |
| Lead / Title | 20px | 400 lead, 600 title | 1.4 | 0 | Supporting sentence, panel title, "Notes" |
| Body | 16px | 400 text, 500 controls | 1.5 | 0 | Running text, fact values, nav, buttons |
| Small | 13px | 400 (500 for the satellite label) | 1.45 | +0.01em | Labels, captions, month labels, clock subline, credits |

Nothing under 13px. No uppercase, no letter-spaced caps (CTS-SAT-1 is a name, not styling).
Running text in Ink; Muted is for secondary notes only. Measure: 26ch for statements, 62ch for
paragraphs.

### Space, shape, motion

- 4px base. Steps: 4 8 12 16 24 32 48 64 96 160.
- Outer margins 16px (up to 599px), 24px (600–1099), 32px (1100 and up). The nav sits on the same
  margins. Gutter 24px desktop, 16px phone. Section gap 160px desktop, 96px phone.
- **Square corners everywhere** (buttons, panels, pictures, pins, thumbnails). The camera's frame is
  a rectangle, so is everything else; the only round thing on the page is the Earth.
- Controls 36px tall desktop, 44px on touch. Touch targets 44 × 44 minimum.
- **Pictures are never cropped, recoloured, blurred or panned.** 4:3 or 1:1, `object-fit: contain`,
  on Space.
- Motion tokens (from the skill's `motion.md`): `--ease-out: cubic-bezier(.22,1,.36,1)`,
  `--ease-in-out: cubic-bezier(.76,0,.24,1)`, `--ease-exit: cubic-bezier(.55,.055,.675,.19)`,
  `--t-press: 140ms`, `--t-hover: 180ms`, `--t-ui: 240ms`, `--t-text: 600ms`. Exits run at 60% of the
  entrance. No bounce, no overshoot, no springs.

---

## 3. The landing: the scroll story

### Stage

- One section, 400svh tall, holding a sticky 100svh stage (canvas plus a text layer). Progress `p`
  runs 0 to 1 over the 300svh the stage is held. Native scroll only: no Lenis, no wheel capture,
  no scroll snapping. The camera follows its scroll target through a damped lerp in the render
  loop (time constant about 120ms) so wheel steps don't stutter. `aria-label="CTS-SAT-1 right now"`.
- **Text sits on black sky, never over the Earth.** The framings below keep sky free for it. Check
  at 1440 × 900, 1280 × 720, 390 × 844 and 375 × 812; if text and Earth meet, move the Earth.
- **The satellite always fits (updated 30 Oct 2026, from the site audit).** The line above it says to
  tap it, so on phones and small windows it comes first. When the end view is short of room, these
  give way in order, as far as that size needs: "Drag to look around"; the facts banner, whose facts
  move into the details; the second half of the live sentence; the subheading. The framing is worked
  out with room for the tallest fact, so it stays still as facts change. Big screens lose nothing.
- One text anchor for every beat: the left margin, block top at 22svh (desktop) or 88px (phone),
  just under the nav.
- The first frame is HTML: the h1, the sentence and the button are painted before WebGL starts.
  The globe fades in (opacity, 600ms) once its textures are ready. No loader, spinner or
  percentage.
- The nav is transparent over the stage: logo left, "Pictures", "Orbit" and "About" right, in Body
  16/500 Ink; the current page gets a 2px Ink underline. ("Orbit" is the full globe tool, section
  5; the landing is the story.)

### Beats

| p | Camera | Text on screen |
| --- | --- | --- |
| 0 – 0.12 | Beat 1 | h1 block |
| 0.12 | | h1 block leaves (360ms, rises 16px, `--ease-exit`) |
| 0.14 – 0.60 | **The swing** (below) | none |
| 0.58 | arriving | Beat 2 statement enters (600ms, from 16px below), once the swing has cleared the sky for it (updated 30 Oct 2026: on a long swing the Earth is still behind the words at 0.56) |
| 0.62 – 0.68 | holds | Satellite and orbit line fade in (opacity, scrubbed) |
| 0.74 | | Beat 2 leaves; beat 3 enters 120ms later |
| 0.80 | | Pins and time controls fade in (240ms); drag is enabled |
| 1 | the stage unpins | The globe stays a full screen to sit on; "What it has seen" follows |

Text entrances and exits are triggered at their threshold and played in time (never scrubbed, so
no line is ever left half-transparent), and they reverse when the visitor scrolls back up.

**Beat 1: the Earth alone.** The whole Earth, about 62% of the stage height, centred at 70% x and
60% y on desktop; on a phone, centred at 50% x and 70% y, 120% of the width, cropped by both sides
and the bottom. It faces Calgary, lit by the real sun for this moment: if Calgary is in night, its
city lights show, and that is right. It turns at real speed. Nothing else is in frame.

> **CTS-SAT-1** (h1, Display)
>
> Calgary To Space's first satellite, built by University of Calgary students and in orbit since
> 3 May 2026. (Lead 20/400, Ink, max 40ch)
>
> [See the pictures] (primary button: Ink fill, Space text, Body 16/500, 44px, square)

**Beat 2: where it is now.** Statement, live:

> Right now it's over the North Pacific Ocean, 507 km up. It goes round the Earth every 95
> minutes, passing over both poles.

- `{place}`: a coarse offline lookup is enough: ocean basins by name ("the North Pacific Ocean",
  "the Southern Ocean"), land by country or province ("Nunavut, Canada", "Antarctica"). With no
  name: "Right now it's 507 km above 12° S, 151° W."
- `{alt}` in whole km; `{period}` from the TLE mean motion, whole minutes. Values update in place
  once a second: no counting up, no flicker, tabular figures.

**Beat 3: it appears; you take over.** Statement:

> Drag to look around. Click the satellite to see the last picture it sent.

On touch: "Drag sideways to look around. Tap the satellite to see the last picture it sent."
The line leaves (240ms) on the visitor's first drag or click; it was an instruction. Once the
visitor drags, the camera is theirs; scrolling back above p 0.60, or pressing Now, gives it back to
the story.

### The one orchestrated moment: the swing

The only loud motion on the site.

- **From** the beat 1 view (about 3.4 Earth radii from the centre, looking at Calgary) **to** a
  view 1,400 km behind and 700 km above the satellite along its direction of travel, pitched down
  so the Earth's limb crosses the frame about 42% from the top (desktop) or 45% (phone), with the
  satellite at 62% x, 60% y (desktop) or 50% x, 64% y (phone). The end frame is the satellite's own
  view: black sky over a thin blue edge, ground below, as in its picture of 6 Aug 2026.
- The view direction moves along the great circle from Calgary to the point beneath the satellite
  (spherical interpolation). Distance and pitch take `--ease-in-out` applied to `p`; the scroll
  itself stays linear. Roll at most 15°. In the last third the camera's up turns from north to the
  satellite's direction of travel.
- The Earth's rotation, the clouds, the sun and the satellite stay at real time throughout. Only
  the camera moves. It lasts 46% of the hold (about 1.4 screens of scroll) and runs backwards
  when scrolled back.

### What must not move

- Text on screen: no drift with the camera, no parallax, no per-letter animation, no typing, no
  scramble, no numbers counting up.
- The nav, the time controls, the status panel and pin labels while the camera moves.
- The Earth faster than real time unless the visitor picks 60× or 600×. No idle auto-spin; clouds
  never drift on their own.
- No stars at all (at this exposure there are none, as in its own pictures), no twinkle, no sun
  sprite, flare or bloom, no pulsing satellite, ping rings or breathing dots, no orbit line that
  draws itself or marches its dashes.
- Pictures never pan, zoom or slide.

### The Earth

- Day: NASA Blue Marble (the current month's Next Generation texture if available), with no
  saturation or contrast boost, ACES filmic tone mapping. The ocean reads deep navy, not cyan.
- Night: NASA Black Marble city lights where the sun is down, over a soft terminator about 8° wide.
- Clouds: NASA cloud texture on its own sphere at +0.3% of the radius, lit by the sun, fixed to the
  ground.
- Atmosphere: a thin shell, 1.5% of the radius (about 100 km). Blue only along the lit limb, none
  on the night side, a faint red at the terminator. The reference is its 6 Aug frame: a crisp thin
  blue edge, no halo beyond it, no bloom.
- Ocean glint: specular on water only (from a water mask), small and sun-coloured.
- Nothing drawn on the Earth: no graticule, borders, labels, grid or hex dots.
- Desktop: 4096 day, night and clouds, 2048 water mask. Phone (up to 820px wide, or
  `deviceMemory` 4 or less): 2048 for everything, device pixel ratio capped at 2, the same story.
- No WebGL: a still NASA Earth picture behind the same text. The live sentence still works
  (satellite.js does not need WebGL).

### The satellite and its orbit

- A free 3U CubeSat model: one 10 × 10 × 34 cm body with body-mounted cells. No large solar wings,
  no generic satellite icon. Lit by the real sun, dark in the Earth's shadow but with enough
  earthshine to stay visible.
- Drawn at a fixed screen size, about 44px long (36px on a phone), far larger than life; the
  footer credit says so.
- Label "CTS-SAT-1" (Small 13/500, Ink) 12px to its right, no box. Model and label are one button,
  at least 44 × 44, named "CTS-SAT-1: where it is now and its latest picture".
- Orbit: one full orbit as a 2px Team blue line: the coming half at 100%, the half already flown at
  35%. Two flat steps, no fade, no dashes.

### Pins

- One pin per picture with a known capture time. Date-only pictures are not placed.
- **A pin is the picture itself**: its thumbnail at 32 × 24 (desktop) or 24 × 18 (phone), 24 × 24 for
  attitude-camera frames, square, with a 2px Ink edge so it reads over cloud and sea. Pins sit on
  the surface and hide behind the limb. No teardrops, dots, glows or ripples.
- Dark frames are the exception: a 10px hollow square, Ink at 55%, with the same card.
- Pins closer than 28px stack as a small pile (each offset 3px) with the count beside it in Small
  Ink, "3 pictures"; clicking a pile moves the camera in until they separate.
- Hover or focus: a card above the pin on Panel, 12px padding: the picture at 160 × 120, the place
  (Body 16/500), the time in Small Muted ("24 Oct 2026, 17:37 UTC"). Opacity in 180ms, no movement.
  On touch, the first tap shows the card and the card is the link.
- Click: that picture in the catalogue (`#/photo/<id>`).
- Pins are real `<a>` elements over the canvas, in date order (newest first) in the tab order.
- Pins arrive at p 0.80 with the controls; they are not in beats 1 and 2.

### Time and speed

Bottom left on the margins (desktop); one row across the bottom above the safe area (phone).

`[clock]  [1×  60×  600×]  [Now]`

- Clock: "21:58 in Calgary" (Body 16, tabular) over "30 Oct, 03:58 UTC" (Small Muted). Off live
  time, the second line reads "2 h 14 min ahead of now" (or "behind").
- Toolbars (the user's request, 31 Oct 2026): the clock, the speeds and Now are one flat Panel bar,
  divided by Raised lines, and so are the two zoom buttons. Everything along the bottom is one height.
  Ink fill is kept for "See all n pictures", and for Now when it has something to do.
- Speed: a segmented control on a Panel track, three radios "1×", "60×", "600×", group label
  "Speed" (`aria-label`). Selected: Raised with an Ink line under it, as the nav marks the current
  page. Others: Muted text, Raised on hover. At 600× an orbit takes about 9 seconds.
- Now: an Ink-filled button "Now" whenever the time is off live or the camera is not following;
  disabled (Muted on Panel, `aria-disabled`, title "Showing now") when live and following. Now
  means: live time, 1×, camera follows the satellite.
- No "LIVE" badge, no red dot, no scrubber track, no hairline timeline, no keyboard-hint sentence.
- Touch: one-finger horizontal drag turns the view; vertical swipes scroll the page
  (`touch-action: pan-y` on the canvas); two fingers orbit and pinch-zoom. The mouse wheel always
  scrolls the page.

### Status panel

(Updated 30 Oct 2026, at the user's request.) Opens from the satellite (click, tap, Enter) or from a
control that is always there at the end view, so nobody has to find the satellite first. There is one
state and one set of details. Closes with the same control, Esc, or a click on empty space.

- **Big screens (where the viewfinder shows):** a summary bar on Panel at the top of the viewfinder's
  slot, reading "CTS-SAT-1 Currently Over Africa, Altitude : 501 km", with two tabs and Hide on the same
  row. "Pictures" is the viewfinder and "Stats" the details, in the same place under the bar; going back
  to Pictures brings back the same picture. No "Latest picture" here (the viewfinder is that), and the
  framing does not move.
- **Laptops and smaller desktops:** the same bar top right under the nav, 380px wide, the tabs on a second
  row. Nothing is open at first: "Stats" drops the details down, "Pictures" drops down "Latest picture",
  and pressing the open one folds it up.
- Both: "Hide" puts the whole panel away, down to a "Show panel" button in the same corner that brings back
  what was showing; the framing does not move, and the choice is remembered. The bar stands in for the
  title, the place line and Close. Panel ground, square, no border, no shadow. Opens in 240ms (opacity,
  8px down); closes in 150ms.
- **Pins (the user's request, 31 Oct 2026):** clicking a pin or a hover card's picture puts that picture
  up in the preview and stays on the page, whether it is whole or not: in the viewfinder where it shows,
  bringing the panel back if need be, and it stays there until Previous or Next; elsewhere in the Pictures
  tab's dropdown or sheet, titled "Selected picture". The preview's own picture is what leads on to the
  catalogue.
- **Phone (the user's request, 31 Oct 2026):** the opening stays as it is. From the story's end, a flat
  Panel bar across the bottom edge, 56px, with icon and word: Stats, Pictures, Facts, Controls. One opens
  at a time above it, its item marked Raised with an Ink line along the top, and pressing it again, or a
  tap on the globe, puts it away; otherwise nothing but the bar sits over the globe. Stats and Pictures are
  a sheet across the full width, opening up to 72% of the height, with a 36 × 4 Muted handle that turns Ink
  while held. The sheet follows the finger on the handle and settles at a peek (down to its first lines),
  open, or as tall as its contents and the nav allow; below the peek, or on a flick down, it folds away, and
  a tap goes between the peek and open. Pictures adds "See all n pictures" there. Facts is the banner just above the bar, off by
  default on a phone. Controls is the clock, speeds and Now over "Play the intro again" and zoom.
- **Words at the end (the user's request, 31 Oct 2026):** once the camera has come in, the words step back
  so the Earth and the satellite are the point. Everywhere: the name at 80% of its opening size, the
  subheading and live sentence at 88%, the two lines under them at 94%. On a phone, more: the name at 62%,
  the subheading 15, the live sentence 16, the lines under it 14, and the big sentence of beat 2 at 20.
- **The Sun and the Moon** say their names beside them under a resting mouse, or for 2.5 s after a tap,
  in the satellite label's style, unless the Earth is in front of them.

Copy, top to bottom:

1. **CTS-SAT-1** (Title 20/600). On the right: "Follow" / "Following" (`aria-pressed`) and "Close".
2. "Also called FrontierSat." (Small Muted)
3. "Over the North Pacific Ocean" (Lead 20/400 Ink)
4. Facts: a 120px | 1fr grid, 10px row gap, no rules; labels Small Muted, values Body Ink tabular.

   | Label | Value |
   | --- | --- |
   | Altitude | 507 km |
   | Speed | 7.61 km/s |
   | Position | 21.40° N, 151.23° W |
   | Sunlight | In sunlight / In the Earth's shadow |
   | Next over Calgary | 18:36 MDT, in 2 h 21 min |
   | Orbits so far | 2,736 |

5. "Worked out from orbital elements published 27 Oct, 22:38 UTC." (Small Muted)
6. **Latest picture** (Body 16/600), the picture at full panel width and its own ratio
   (312 × 234), the place (Body 16/500) "Antarctica", the time (Small Muted) "25 Oct 2026, 00:54
   UTC", a status line only when it is not checked and whole (Small Ink): "Cut short on board: only
   the top third was saved." Then the link "Open in the catalogue". The picture is a link too.

States:

- Loading: the same layout, each value replaced by a flat Raised bar at its real size; labels shown
  at once; no shimmer.
- Elements over 7 days old: line 5 turns Ink: "These orbital elements are 9 days old, so the
  position may be off by tens of kilometres."
- No elements: "Couldn't work out where it is: no orbital elements loaded." and "Try again".
- Off live time: line 2 becomes "At 05:12 in Calgary, 2 h 14 min ahead of now"; values follow the
  simulated time; the latest picture stays the newest one.
- Picture failed: inside its 4:3 frame on Panel, "The picture didn't load." and "Try again".

### Reduced motion, and "Play the intro"

- With `prefers-reduced-motion: reduce` the section is 100svh with no hold. The page opens on the
  end state of beat 3: the camera over the satellite, pins and controls showing. The h1 block stays
  top left: the h1, the supporting sentence, the live beat 2 sentence (Lead 20/400), then two
  actions: "See the pictures" (the button) and **"Play the intro"** (a text button, Body 16/500
  Ink, underlined).
- "Play the intro" runs the three beats once on a timer (beat 1 2.5s, swing 3s, beat 2 2s,
  satellite 0.5s, beat 3 1.5s: about 9.5s) and returns to the interactive state. While it plays the
  button reads "Stop the intro". It only ever plays when pressed.
- Everything else under reduced motion: no travel, opacity changes only (200ms or less). The
  satellite and the Earth still move at real time: that is content, and slow.
- No script: the h1 block, a still Earth picture, and "What it has seen" with every picture.

### After the globe: "What it has seen"

- h2 (Statement): **What it has seen**
- Lead: "29 pictures since June, each sent down in hundreds of small radio packets, picked up by
  volunteer ground stations and rebuilt here." (count and first month computed)
- Every picture as a contact sheet: rows 120px tall (72px on a phone), natural ratios, 8px gaps,
  newest first, wrapping. A month label (Small Muted: "Oct", "Sep") before each month's first frame.
  No captions, no hover zoom, no dimming. Each frame links to the catalogue. Partial pictures show
  their grey.
- Under it, Small Muted: "13 of them have a known time, so they're pinned on the globe. The rest
  have only a date." Then the same button, "See the pictures".

### Footer

On Space, no columns, no rules: the logo (white, 28px tall), then two lines in Small Muted with Ink
links: "Earth: NASA Blue Marble, Black Marble and cloud imagery. Orbital elements:
Space-Track.org. Packets: the SatNOGS network and the CalgaryToSpace ground station." and
"CubeSat model: {title} by {author}, {licence}; drawn far larger than life." Then
calgarytospace.ca and the GitHub link.

---

## 4. The catalogue (an app screen)

Style: true-black-flat on our tokens. The screen's question: **what is this picture, where and when
was it taken?** So the picture is the largest thing, and its place is the largest type.

### Desktop (1440 × 900)

- Nav 64px, as on the landing ("Pictures" is the current page; the team's "Your name" control
  lives here only).
- Grid: viewer (1fr) | info (400px), gutter 24, margins 32.
- **Viewer.** (Updated at checkpoint 1.) A picture is never drawn larger than its own size (640 × 480,
  attitude camera 512 × 512): enlarged, it goes grainy. The viewer is a Panel stage, as tall as fits
  above the browse dock (up to 720px), with the picture centred on it at 1× or smaller, never
  cropped. The stage keeps the edges of night and black-edged frames visible. Two and Four use the
  same stage at the same height, with their pictures centred on it as a group and each caption
  directly under its picture.
- **Dark frames** (`dark: true`: black, noise, or the Sun as a single dot) are left out of the strip
  by default. In the dock row, after the count, in Small: "7 dark frames hidden: nothing but black,
  sensor noise or the Sun as a single dot." and the text button "Show them" / "Hide them". A
  direct link to a dark frame opens it with them shown.
- **Info column**, top aligned with the picture:
  - h1 (Statement): the place, "Alberta, Canada". With no place, the date: "24 Oct 2026".
  - Body Muted: "24 Oct 2026, 17:37 UTC" and, on the next line, "11:37 MDT in Calgary".
  - A status line in Body Ink, only when the picture is not checked and whole (copy below).
  - Actions: "Show on the globe" (the one primary: Ink fill), then text buttons "Compare",
    "Download", "Copy link", "All details". They come before the facts, so a long list of facts
    can't push them off a laptop's screen.
  - Facts: a 120px | 1fr grid, 12px row gap, no rules; labels Small Muted; values Body Ink, with a
    second Small Muted line saying what a value rests on.

    | Label | Value | Second line |
    | --- | --- | --- |
    | Taken | 24 Oct 2026, 17:37:32 UTC | From the file name |
    | Where | 51.14° N, 113.24° W, 504 km up | Worked out from orbital elements |
    | Light | Daylight below, sun 23° up; satellite in sunlight | |
    | Camera | Main camera, 640 × 480 | |
    | Came down | 1,124 packets, 24 Oct 22:36 to 25 Oct 00:14 UTC | |
    | Check | Matches the satellite's checksum | |
    | File | `camera/2026-10-24_173732L.img`, 54 KB (Mono) | |
    | sha256 | `41e7b66dd5c7…` (Mono) and "Copy" | |

  - "Notes" (Title 20/600), the team's notes in Body; empty: "No notes yet." Edit fields follow
    the same tokens: label above, 40px tall, Panel fill, no border, blue focus ring.
- **Browse dock**, full width at the bottom on Space:
  - A 36px row: "Show" and a segmented One / Two / Four; "Newer" and "Older" text buttons; on the
    right "29 pictures" and the filters (if kept, as plain selects in one row).
  - The filmstrip: every thumbnail 72px tall at its natural ratio (96 × 72, attitude frames
    72 × 72), 4px gaps, one row, newest first, scrolling sideways inside its own row only. A month
    label (Small Muted) above each month's first frame. The selected frame has a 3px Ink bar under
    it and `aria-current="true"`; hover shows that bar at 40%. No dimming, no hover zoom, no
    borders. The selected frame is kept in view.
- Keys: ← and → step newer/older; Home and End jump to the ends.

### Compare

- **Two:** the viewer splits into two equal cells side by side; **Four:** a 2 × 2 grid. Each
  picture keeps its ratio, with a caption under it: the place (Body 16/500), the time (Small Muted)
  and "Remove".
- The active cell is the one the next filmstrip click fills, marked with the same 3px Ink bar
  under its caption. Clicking a cell makes it active; filling one moves the mark to the next empty
  cell. The info column shows the active cell's facts.
- Empty cell: Panel at 4:3 with, in Small Muted, "Pick a picture from the strip below."
- Back to One keeps the active cell's picture. The URL holds the set
  (`#/compare/<id>,<id>[,<id>,<id>]`) so a comparison can be shared.

### Phone (375)

- Nav 52px. The picture across the width inside the 16px margins (343 × 257). Directly under it,
  the Show / Newer / Older row and the filmstrip (56px tall). Then the h1, the facts (label above
  value), notes and actions. A sideways swipe on the picture steps newer/older.
- Two: stacked, each full width. Four: 2 × 2 at about 167 × 125, captions with the place only.

### States and copy

| Case | What shows |
| --- | --- |
| Checked (verified) | No status line. Check: "Matches the satellite's checksum" |
| Complete, unchecked | "Complete, but there's no checksum to check it against." |
| Partial, main camera | The file as it is: the flat grey is where data never came down. Never crop, repaint, blur or hide it. "Part of this picture never came down: about 19% of it arrived." (from `completeness`) |
| Partial, attitude camera | "Grey bands are rows that never came down." |
| Cut short on board | "The satellite stopped this capture early: it saved lines 0–249 of 775, and all of that came down." (numbers from the status note) |
| Date only | h1 is the date. Where: "Not known. Only the date of this picture is known, so it isn't on the globe." "Show on the globe" is disabled with that sentence as its description. |
| Still coming down (partial, last packet under 24 h ago) | "Still coming down: 62% so far. Last packet 2 h ago." |
| Night or near-black frame | No special treatment; the Light fact says "Night below". |
| Loading | The frame at its ratio on Panel; fact values as Raised bars at real size; thumbnails as Panel boxes at their size. No shimmer, no layout shift when data lands. |
| Picture failed | Inside its frame: "This picture didn't load." and "Try again". |
| No matches | In the strip row: "No pictures match these filters." and "Clear filters"; the viewer keeps the last picture. |

---

## 5. Orbit page (`site/globe/`)

The user likes its layout and proportions on a large monitor: the big globe, the two narrow
columns in the corners (left 280px, right 300px), the clock bar along the bottom. **Keep all of
that.** What reads as generated is the type and the labelling: 11px tracked capitals for panel
headings, IBM Plex Mono on most values, 11–12px text, `·` chains, `→` arrows, an orange second
accent, and 1px slate boxes. Change those, in this order.

### Typeface, for the whole site

Keep **Jost** (Google Fonts) for everything. The generated feel does not come from Jost. It comes
from Mono plus tracked capitals plus 11px type. Jost is a Futura revival, the face of the Apollo 11
plaque, and it has true tabular figures, so it can carry the live numbers.

- Orbit page font link: `https://fonts.googleapis.com/css2?family=Jost:wght@400;500;600&display=swap`.
  No Plex Mono on this page: nothing on it is code.
- Elsewhere, Plex Mono 400 only inside `<code>` (file names, sha256, TLE lines).

**When is monospace still right?** Not for tabular numbers. Jost does those: put
`font-variant-numeric: tabular-nums` on the `.cg` root, which keeps the seconds, coordinates and
pass times from jittering (measured: "0000" and "1111" are equally wide). Mono is only for literal
machine strings someone copies character by character, and on this page there are none.

### Sizes: three, and nothing under 13px

| Role | CSS | Used for |
| --- | --- | --- |
| Title | `font: 600 20px/1.2 var(--cg-sans); letter-spacing: -0.01em` | "CTS-SAT-1" in the header |
| Value | `font: 400 16px/1.4 var(--cg-sans)`; panel headings and list titles take weight 600 or 500 | Panel headings, readout values, pass times, picture rows, the clock's first line, the status line |
| Small | `font: 400 13px/1.45 var(--cg-sans); color: var(--cg-muted)` | Labels (`dt`), second lines, the credit, scrub labels, the clock's second line, tabs and buttons (weight 500, Ink) |

- **Minimums: 13px for anything readable** (this includes `.cg-fine`, `.cg-credit`, which is 10px on
  narrow screens today, the scrub labels, `.cg-label`, the tooltip and the card text). 16px for any value.
  Touch targets 44px (`.cg-narrow .cg-btn { height: 44px }`).
- Tracking 0 at 13 and 16px; -0.01em at 20px. **No `text-transform: uppercase` anywhere on the
  page.**
- Keep the column widths. If a row wraps at 16px, shorten the words, not the type.

### Panel headings

Replace `.cg-panel h2 { 600 11px; letter-spacing: .08em; uppercase; muted }` with:

```css
.cg-panel h2 { font: 600 16px/1.3 var(--cg-sans); letter-spacing: 0; text-transform: none; color: var(--cg-text); }
.cg-panel-head { margin-bottom: 12px; }
```

The heading is set apart by weight and by the 12px below it, not by caps, tracking or grey.
Names in sentence case, saying what the panel holds:

| Now | New h2 | Right of it (Small) |
| --- | --- | --- |
| SATELLITE | **Right now** | the Follow button |
| PASSES OVER CALGARY | **Passes over Calgary** | (nothing; the conditions move to a line under it) |
| PHOTOS | **Pictures** | "29, 13 on the globe" (computed) |

### Writing rows without `·`, `→` or Mono

Rules: **no `·` anywhere**. Two facts become two lines, or one phrase joined by a comma or a word
("to", "from", "in", "up"). Ranges take an en dash (18:36–18:44). Directions are joined by "to",
never by an arrow. Every figure carries its unit or a word ("36° high", not "36°").

**Satellite panel ("Right now").** Labels are Small, values are Value with tabular numbers:

| Label | Value (examples) |
| --- | --- |
| Latitude | 60.24° S |
| Longitude | 113.71° E |
| Altitude | 514 km |
| Speed | 7.61 km/s |
| Sunlight | In sunlight / In the Earth's shadow / At the edge of the Earth's shadow |
| Below | Daylight, sun 43° up / Night, sun 12° below the horizon / Twilight |
| Orbits so far | 2,736 |

Under it, in Small: "Worked out from orbital elements of 27 Oct, 22:38 UTC (2 days old)." Over 7
days old, it turns Ink and adds: "so the position may be off by tens of kilometres."

**Passes panel.** Under the h2, in Small: "Times in Calgary, for passes higher than 10°." Then the
status line in Value Ink: "Next pass in 2 h 21 min" or "In view now, 34° up in the SW". Drop the
"Rise / Max / Set / Max el" column header and the three UTC columns. Group by day, and give each
pass two lines:

```
Friday 30 October                     <- Small, weight 600, Muted
18:36–18:44              36° high     <- Value 16/500 Ink, tabular; the height right-aligned
From NNE to S                         <- Small Muted
```

UTC goes into the row's `title` and `aria-label` ("Rises 00:36 UTC, 31 Oct"). The clock already
shows UTC. Rows are separated by 12px of space; if the list runs together, use a 1px
`#1A2129` rule (an app-screen exception), never `#3A4855`.

**Pictures panel.** Today the title is a date and the meta line repeats the same date in Mono. New:

```
Alberta, Canada                       <- Value 16/500 Ink: the place; with no place, "24 Oct 2026"
24 Oct 2026, 17:37 UTC                <- Small Muted, tabular; for date-only pictures: "Time not known"
```

The group heading for unplaced pictures reads "Not on the globe: only the date is known" (Small,
600, Muted) instead of "Time unknown · not placed". The selected row gets a 3px Ink bar on its left
edge and keeps its title in Ink (not orange). Optional, if the markup is touched: a 40 × 30
thumbnail at the row's left edge, the same picture as its pin.

**Selected-picture card.** Title (Value 16/600): the place. Then lines in Small: "25 Oct 2026,
00:54 UTC" / "60.24° S, 113.71° E, 521 km up" (Ink) / "Daylight below, sun 18° up". The link reads
"Open in the catalogue". Today the time is split onto two Mono lines; make it one line, no Mono.

**Header (left column).** "← Gallery" becomes "All pictures" (Small 500, Ink, underlined, no arrow).
Then the h1 "CTS-SAT-1" (Title), and in Small Muted: "Also called FrontierSat. NORAD 69015." The
credit as sentences, in Small Muted: "Earth imagery: NASA. Orbits: Space-Track.org. Places ©
OpenStreetMap contributors."

**Keyboard line.** Remove "Space play/pause · N now · ← → 1 min, with Shift 1 h · F follow" from
the page. Put it behind a `<details>` with the summary "Keys" (Small 500 Ink). Inside, a `dl` with
`<kbd>` in Jost 13/500 on `#1A2129`, with no border:

| Key | What it does |
| --- | --- |
| Space | Pause or play |
| N | Back to now |
| ← → | One minute (with Shift, one hour) |
| F | Follow the satellite |

**Clock bar.**
- Line 1 (Value 16/500, tabular): "30 Oct 2026, 03:58:36 UTC". Drop the "· live" suffix: the
  disabled Now button already says it.
- Line 2 (Small Muted): "21:58 MDT in Calgary".
- Speed buttons "1× 60× 600× 3600×" in Jost 13/500 tabular (not Mono). Scrub labels in Small: "A day
  earlier", the offset ("+2 h 14 min", or "Now"), "A day later".

**Labels and tooltips on the globe.**
- `.cg-label` becomes `font: 500 13px/1.2 var(--cg-sans); letter-spacing: 0`. The 2px halo in the
  ground colour can stay, for legibility over cloud; it must not be a glow.
- Tooltips: "Antarctica, 25 Oct, 00:54 UTC" and "Click to follow CTS-SAT-1".
- Notes that are joined with " · " become separate sentences.

### Colour and chrome (with the type change, same pass)

- Tokens: `--cg-bg #05070A`, `--cg-panel #10151B`, `--cg-panel-hover #1A2129`, `--cg-text
  #E6EBF0`, `--cg-muted #8A96A3`, `--cg-accent #3C9DF5`.
- **The orange goes.** The blue marks only the satellite, its orbit and track, and focus rings (2px,
  offset 2px).
- Selected and pressed states are Ink: Follow when on, the current speed, the current tab. That
  means `background: var(--cg-text); color: var(--cg-bg)`, or a 2px Ink bar for tabs.
- Panels lose their 1px `#3A4855` border and are told apart by the Panel fill alone
  (`border: 0; padding: 16px`). Buttons: `border: 0; background: #1A2129; height: 32px`.
- The range track becomes 2px of `#1A2129` and the thumb stays Ink. The column positions and widths
  do not change.

---

## 6. Checklist: tells to keep off these pages

One exception, the user's choice (30 Oct 2026): the picture viewfinder on the landing's end view
(`site/explore/viewfinder.js`) has corner brackets, a crosshair and a top-down reveal with a faint
scanline, on purpose. Its data and captions still sit around the picture, never on it, in Jost and
sentence case. These stay off every other page and component.

The globe and the scene

- [ ] A glowing halo, cyan rim light or bloom around the Earth (the atmosphere is a thin edge)
- [ ] A starfield, nebula, purple or teal space gradient, twinkling or parallax stars
- [ ] Lens flare, a sun sprite, god rays
- [ ] Over-saturated or "HDR" Earth, cyan oceans, procedural or noise clouds
- [ ] Graticule lines, country outlines, hex-dot or wireframe Earth, a grid floor
- [ ] Pulsing satellite, radar ping rings, breathing dots, a "LIVE" badge with a red dot
- [ ] A generic winged satellite icon instead of a 3U CubeSat
- [ ] Teardrop map pins, glowing dots, ripple markers
- [ ] Auto-spinning Earth as a screensaver; the orbit drawing itself on a loop
- [ ] Invented telemetry (battery, signal, temperature). Only what is computed, and say from what

Type, labels and chrome

- [ ] HUD costume: tiny tracked uppercase labels ("SATELLITE", "PASSES OVER CALGARY"), monospace
      everywhere, corner brackets, crosshairs, scanlines
- [ ] Eyebrows ("PICTURES FROM ORBIT") or pill badges above a heading
- [ ] Zero-padded counters ("01 / 12"), "Step 02", numbered sections
- [ ] 1px outlined panels and boxes, hairline dividers between facts or sections
- [ ] Glass: backdrop blur over the globe or a sticky bar
- [ ] A second accent (the globe's orange), neon cyan, violet; the blue on buttons or nav
- [ ] Rounded 12–16px cards; a floating pill nav

Layout and components

- [ ] A centred stack of eyebrow, headline, subtitle and a round arrow button
- [ ] Photo cards with hover zoom, Ken Burns pans, a lightbox with a blurred backdrop
- [ ] Gradient scrims and mono captions laid over pictures (captions go under them)
- [ ] A three-column link footer
- [ ] Text set over the Earth; anything crossing a line while it is being read

Motion and copy

- [ ] Typewriter, scramble or "decode" text; numbers that count up; scanline picture reveals
- [ ] The same fade-up on every block; staggered entrances in the hero
- [ ] A preloader, "Initializing…", a percentage counter, "Scroll to explore", a bouncing chevron
- [ ] Words of the genre: explore the cosmos, journey, embark, witness, discover, breathtaking,
      stunning, seamless, real-time insights, "not just a satellite"; tricolons; more than two em
      dashes on a page

The current site's own tells (to go with the redesign)

Measured baseline (`inspect.mjs` on http://localhost:8000/, 29 Oct, saved in
`.taste-skill/before/`): **10 FAIL, 6 WARN**. Eyebrow; IBM Plex Mono is 18% of the type; the "01"
counter; a gradient and a blue glow on the drawn horizon; 7 hairlines; body text measured at 12px
and 58 text blocks under 13px; a page where only 2 elements move; captions 14px from the edge at
768 and 390; running text in grey (6.1:1); the h1 is the eyebrow plus the name and measures as a
30px title. Seen in the browser:

- [ ] The eyebrow "PICTURES FROM ORBIT" in tracked capitals over a centred headline, inside the h1
      (the new h1 holds the name only)
- [ ] The round blue arrow button under the hero
- [ ] The CSS-drawn horizon (`.limb`) with a blue box-shadow glow, while the satellite's own 6 Aug
      picture shows the real horizon
- [ ] The canvas starfield
- [ ] Mono date captions on a gradient scrim over the reel pictures; the reel's slide-in and pan
- [ ] The "01 … 12" reel counter on a 1px progress track
- [ ] 1px hairlines under the header, around the facts, above the footer, and the 1px divider
      beside the wordmark
- [ ] The sticky filter bar with backdrop blur
- [ ] The three-column footer in 12px grey
- [ ] On the phone, a first screen with no picture and a large empty band under the drawn horizon
- [ ] Body text at 15px and captions at 11–13px in grey
- [ ] On the old globe page: the orange accent, boxed HUD panels with tracked uppercase labels,
      mono everywhere, and the keyboard-hint sentence in tiny type

---

## 7. What the reviews will check

At 1440 × 900 and 375 × 812, and with reduced motion: the first frame says what this is before
WebGL loads; text never sits over the Earth at any `p`; one loud motion (the swing) and nothing
else that travels; the blue only on the orbit and focus rings; Mono only on files, hashes and IDs;
no 1px boxes, glows, blur or gradients; five type sizes; pictures whole and uncropped; every
control reachable by keyboard with a name; counts computed, not typed. `inspect.mjs` runs on each
page; its scene and still-page checks are read with judgement for the WebGL stage, every other
`FAIL` is fixed.
