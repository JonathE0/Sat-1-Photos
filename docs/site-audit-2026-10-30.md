# Site audit, 30 October 2026

Three agents went through http://localhost:8030 on emulated devices, in real
Chrome driven by a script:

- **Phones:** 320×568, 360×800, 390×844, 430×932 and 844×390 (on its side), with touch.
- **Tablets and laptops:** 768×1024, 820×1180, 1024×768 and 1180×820 with touch;
  1280×720, 1366×768, 1440×900 and 1536×864 with a mouse; and 69 live-resize stops.
- **Big screens and conditions:** 1920×1080, 2560×1440, 3840×2160, 3440×1440 and
  1280×600; keyboard only, reduced motion, no WebGL, slow and dropped network,
  deep links, data sanity.

There are no blockers: every flow can be finished on every size tested. Duplicates
across the three reports are merged below, so a single entry may have been found
more than once. File and line references were correct at commit 4680b85.

**What this could not test:** real iOS Safari, Firefox, real Android devices,
a real on-screen keyboard or collapsing browser bars, real GPU frame rates, and a
real screen reader. The phone heights with browser bars (390×664, 360×648) are
estimates, not measured on devices.

## Fix first

The lead session checked these eight against the screenshots or the code.

**All eight are fixed on `main` (631db2c).** The trade-offs that came with them:

- **#1:** when a phone or small window has too little room, things drop in a set order. The facts banner goes first (its facts stay available in the satellite details), then "Drag to look around", then the second half of the live sentence, then the subheading.
- **#3:** on short windows the stage for Two and Four is taller than fits above the filmstrip, so the page scrolls to reach it.
- **#2:** on short windows the Passes panel gets less room and scrolls inside it.
- **#7:** on Slow 3G the words appear at 6.4 s instead of about 32 to 34 s, but the Earth arrives 3.8 s later (54.1 s against 50.3 s), and words can show in a fallback font and re-wrap before the real one loads. On the Orbit page, Credits doesn't respond until the globe's code has loaded.

| # | Where | What's wrong | Likely cause |
|---|---|---|---|
| 1 | Explore, phones; small landscape windows | The facts banner covers the satellite while the line above says to tap it. At 390×664 the tap lands on the banner and the panel stays closed. On a phone on its side the banner also covers the headline text, and a tap on the satellite can hit "See all 31 pictures". Full-height 390×844 is fine, which is why it's easy to miss. | `explore/journey.js:703`, `explore/journey.css:418`, `:844` |
| 2 | Orbit, side panels | The Pictures list has no height: 0 px at 1366×768 and 1280×720, 11 px at 1180×820. Once a place is chosen it disappears at every size, even 2560×1440, while Tab still walks through its invisible buttons. | `globe/globe.css:265`, `:273`, `:452`; `globe/placesearch.css:156` |
| 3 | Pictures, Four | Captions overflow the stage and print over Show, Newer and Older. Pictures shrink to thumbnail size at 1024 to 1366 wide, and to 13 px at 1280×600. Affects a 1080p monitor in a normal browser window (1920×950). | `assets/catalogue.css:181`, `:232`, `:257` |
| 4 | Explore | Arriving from a scrolled page before Explore has been shown lands mid-story, sometimes on a screen with no words. A shared picture link is exactly this route. | `assets/app.js:201` scrolls nothing; Pictures and About do |
| 5 | Explore, wherever the viewfinder shows | A pin's hover card opens upward and the viewfinder hides its top, by 75 to 100 px. | `explore/journey.css:433`, `:627`; `explore/journey.js:1436` |
| 6 | Orbit time picker, 320 wide and on a phone's side | The × is under the site nav: tapping it goes to About or opens Credits. The title collides with the logo. | `globe/timepick.css:182` |
| 7 | Every main-site page on a slow connection | Only the nav shows for 32 to 46 s on Slow 3G, even on About, whose words are already in the HTML. There is no loading text. The 3D model also gives up after 20 s and keeps its stand-in. | `assets/app.js:11` loads the whole globe first; `explore/satellite.js:219` |
| 8 | Picture detail page (`#/photo/<id>`) | Never adapted to big screens: at 2560 wide the picture fills 13% of its stage, and at 3840 wide 6%, with arrows up to 922 px from it and form fields 1,173 px wide. It still has the old look: 54 of 65 text nodes under 13 px, mono times, and the date as its title where the catalogue uses the place. | `assets/style.css:415`, `:481`, `:532`, `:605` |

## Next

**All 25 are fixed on `main`.** Tested in emulated Chrome at the sizes above; the limits listed at the top still apply, so rotation, swipes and a phone's keyboard closing haven't been seen on a real phone. The trade-offs that came with them:

- **#9, #10:** in Two on a phone the caption sits beside the picture, so the pictures can be larger (222×167 at 390 wide). In Four on a phone on its side the strip runs slightly past the bottom of the screen, and at 568×320 each picture is only 73 px wide.
- **#11:** below 360 wide the logo is hidden, because the six links fill the row; Explore goes to the same place. Below 390 the nav text is 12 px, under the design's 13 px minimum, because 13 px doesn't fit with the logo.
- **#12:** after choosing a place, focus moves to the results heading, so searching again takes a click or Shift+Tab.
- **#13:** province and state outlines are hand-drawn and coarse, right to within a few tens of km. Small places count as at least 40 km across for passes, so "Passes over Singapore" means near it.
- **#14:** a coast within 100 km names the country when the coarse answer is land or vague, but only within 25 km when it's a named sea, so close to a coast the name can go either way. For the first second or two Explore says "Working out where it is right now." On Slow 3G a coarse name shows first and the country can replace it once.
- **#17:** on phones the time slider hides while a sheet is open, and the sheet is shorter, so it scrolls more. While a sheet is open the view moves by itself to keep the satellite in the window until the visitor drags or zooms, so at high speed it chases the satellite. In the tabbed layout the source credits move from the header to Credits, and from 760 to 899 px wide the slider's end labels are hidden.
- **#20:** the end of the story is remembered for the tab only. A new tab, a reload or "Play the intro again" starts it over.
- **#26:** every main-site page now also downloads the orbit code and data (about 180 KB before compression) to work these out, and the values appear a moment after the page does.
- **#27:** on a 4K screen a single picture still sits at 640×480 in a very large stage, because pictures are never enlarged.
- **#29:** Explore has no page scrollbar at all, on the story or at its end. Wheel, keys and touch still scroll. `scrollbar-gutter` would also stop the jump, but leaves a blank 15 px strip beside the Earth.
- **#31:** the big sentence is on screen for less of the scroll: from 0.58 to 0.74 instead of 0.52 to 0.74.
- **#33:** below about 690 px a row has no UTC time or direct Orbit link; both are one tap away. On phones the filters are one row that scrolls sideways, and they stop being sticky on screens under 500 px tall. "How this list is made" starts collapsed, and from 1680 px wide the first row starts open, so one map loads straight away.

| # | Where | What's wrong |
|---|---|---|
| 9 | Pictures, phone on its side | A whole picture never fits: 480 px tall on a 390 px screen. Four has the same problem. (`assets/catalogue.css:661`) |
| 10 | Pictures, Two, phones and portrait tablets | The cells stack, so both pictures never fit. "Pick a picture from the strip below" points off-screen, and filling a cell happens out of sight. (`assets/catalogue.css:667`) |
| 11 | Nav, 320 wide | Doesn't fit below about 346 px: Explore overprints the logo, Credits is cut off on Orbit, and Watchlist pans sideways. |
| 12 | Orbit place search, phones | The keyboard stays up after choosing a place and hides the results. (`globe/placesearch.js:132`, `:197`) |
| 13 | Orbit place search | "Alberta" picks Algeria (two typos allowed). Singapore, Malta, Bermuda and Hong Kong aren't found, and two of those are countries. (`explore/journey-region.js:455`) |
| 14 | Place names | Explore says "Africa" where Orbit says "Burkina Faso". Orbit's header and picture card can disagree. Coastal Japan comes out as "Asia" or "North Pacific Ocean". (`regionAt` against `placeAt`) |
| 15 | Credits | The page scrolls behind the dialog, Close scrolls out of view, and it stays open through browser Back. (`assets/credits.js`, `assets/credits.css:22`) |
| 16 | Orbit | Says "Right now" and "In view now" while showing another time, even in 2040. (`globe/globe.js:161`, `:1088`) |
| 17 | Orbit, tabbed layout | An open sheet hides the satellite and leaves almost no globe: 3 px at 390×664, and about 90 px at 1024×768 and 1280×600. The globe doesn't re-frame. The header text sits on the Earth with no backing. (`globe/globe.css:869`, `:885`; `globe/map2d.css:44`) |
| 18 | Pictures | Zero filter results still show a picture and its facts. (`assets/catalogue.js:914`) |
| 19 | Orbit, Copy link | A link made with Follow on reopens with Follow off and no time, so the satellite has moved out of view. (`globe/globe.js:1388`, `:1417`) |
| 20 | Explore | Finishing the story isn't remembered after visiting Orbit or Watchlist through the nav, so it has to be scrolled again. Whether that's unwanted is a judgement call. |
| 21 | Explore, phones | Rotating late in the story skips to the end and locks. (`explore/journey.css:58`, `explore/journey.js:1065`) |
| 22 | Explore, phones | The swipe that finishes the story dismisses "Drag to look around" and lights "Now". (`explore/journey.js:2021`) |
| 23 | Tap targets | Main-site nav links are 19 to 20 px tall against 42 to 44 on Orbit and Watchlist. Also small: facts source link, catalogue inline buttons, Credits links, "Open in the catalogue". (`assets/style.css:165`) |
| 24 | Failure states | Orbit says "No pictures yet." when the data failed to load. A 404 shows the public a developer command. There's no retry after a network failure on Pictures. Failed images show bare broken icons. "Click on the satellite" still shows when there is no satellite (no WebGL, or no orbit data). (`globe/globe.js:856`, `assets/app.js:279`, `explore/journey.js:1841`) |
| 25 | Keyboard and screen readers | Focus hides under the sticky header on Shift+Tab (Watchlist, detail). Escape stops closing the time picker and colour wheel once Tab leaves them. Focus is dropped on route changes to Explore and Pictures. Watchlist's live region changes every 30 s. |
| 26 | Team-corrected pictures | Four pictures (2026-10-06, 2026-09-03, 2026-08-06, 2026-07-20) show altitude and light on Orbit but not in the catalogue or viewfinder. (`explore/viewfinder.js:67`) |
| 27 | Very wide screens | Pictures is capped at 1,784 px, 46% of a 3840 screen, with 584 px blank under the filmstrip. Watchlist has 296 px blank under each map. |
| 28 | Pictures, 1920×1080 | The filmstrip shows 13 of 21 and ignores the mouse wheel. |
| 29 | Explore, Windows scrollbars | Everything jumps 15 px when the story locks. Fix with `scrollbar-gutter`. |
| 30 | Orbit | The "CTS-SAT-1" and "Calgary" labels collide on the Alberta picture, reading "CalgaryAT-1". (`globe/scene.js:732`) |
| 31 | Explore story | The second beat's text sits over the Earth for one scroll step, up to 64% of it at 1440×900. (`explore/journey.js:86`) |
| 32 | Pictures, detail | A long unbroken string in Notes, such as a URL, breaks the page width. (`assets/catalogue.css:623`) |
| 33 | Watchlist | 18,700 px long on a phone and 10,900 px on a laptop, with filters that scroll away. |

## Polish

- Orbit: "Keys" opens below the fold, and also shows on touch where there's no keyboard.
- Pictures: the Download and Copy link row falls at the fold on 1366×768 and 1280×720; uneven line spacing in the hidden-frames notes.
- Explore: swiping up on the peek sheet's body does nothing (only the grabber); pins sit half under controls at some times.
- Orbit Map: the header has no backing once zoomed; the rightmost longitude label sits under the zoom buttons; the time picker runs into an open sheet.
- Viewfinder: drops the date from Calgary time ("18:54 MDT" where the catalogue adds "on 24 Oct").
- Orbit's "Not on the globe: only the date is known" also covers 3 frames with no date at all.
- One picture has two titles and two vocabularies between catalogue and detail (Taken/Captured, Where/Position, Came down/Downlinked).
- The footer is under the 13 px rule.
- The nav is built three separate ways: heights differ, the logo shifts 8 px on Watchlist, and Orbit underlines the current page in team blue.
- Screen-reader labels: "24 Oct 2026, 24 Oct 2026" repeats. Orbit has 62 tab stops. Explore's end tabs through the bottom controls before the top right.
- Night passes: the satellite is invisible in shadow, and dark-frame pins read as empty boxes. A matter of taste.
- 4K at DPR 1: type and panels stop growing, so everything looks small.

## Decisions rather than bugs

- **Reduced motion.** The design doc promises a short page with no swing for people whose system asks for reduced motion. The site now keeps the motion, because the owner wants it and has that setting on. Either update the doc, or add an on-page motion switch so other people with that setting still get a calm version.
- **"See all 31 pictures"** lands on "21 pictures", with 10 behind "Show them". The hiding is intended; the wording could change.
- **"Play the intro again"** returns to the top and waits for scrolling rather than playing.
- **The viewfinder's first picture** is the newest viewable one, currently a cut-short frame. It could open on the newest complete picture.
- **The orbit line crossing the words** was reported as a flaw against the design doc, but it was the owner's request. The doc may want updating.
- **Earth position at 1920×1080.** It sits lower so the picture fits at full size. Smaller pictures would give it more room.

## Feature ideas

Small:

- **Lobby mode.** `?kiosk=1` on Explore: no nav, locked end view, rotating pictures and facts, and a big countdown to the next pass over Calgary, for lab screens and team events. Everything it needs exists already.
- **Mark the event on Orbit.** "Show on the Orbit page" sets the time but draws nothing; pass the event's place and mark it.
- **Share on phones.** `navigator.share` with the picture's place and link, alongside Copy link.

Small to medium:

- **Add a pass to my calendar.** A downloadable calendar file from Passes and the Watchlist, using times the site already computes.
- **Full-screen picture view.** A clean, rotation-friendly view with swipe to step.
- **Picture tour on Orbit.** "Next picture" flies the globe from pin to pin in date order, turning the pins into the story of the mission.

Medium:

- **Real beside simulated.** A placed picture next to the simulated frame for the same moment. The simulator exists, 18 pictures qualify, and the difference shows the team how far the camera's pointing was off.
- **How it came down.** A small timeline per picture from first packet to last, with packet count and how complete it is.
- **Mission timeline band.** A full-width strip from launch to today with capture ticks and downlink spans.
- **Picture wall for big monitors.** Above about 2400 px wide, every picture at natural size, grouped by month, so big screens aren't half empty.

Medium to large:

- **One world map on the Watchlist.** All open events plus the next day's ground track, linked to the cards.

## Notes on the run

- Port 8030 runs `serve.py`, not a plain static server, so `/api/annotations` answers there and the edit form is live. Nothing was saved or POSTed.
- One agent's script tapped a Credits link by accident, which loaded Harvard's public star catalogue page once in its test browser. Nothing else went to an external site.
- Screenshots and scripts are in this session's scratchpad under `audit/`, not in the repository.
