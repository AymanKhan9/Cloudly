---
name: Cloudly
description: Coding agents on a server you already own, logged as observations from your own weather station.
colors:
  atlas: "#1f3f8c"
  atlas-deep: "#17316e"
  atlas-2: "#27509f"
  atlas-3: "#3061b3"
  signal: "#ff5a1f"
  signal-hover: "#ff7440"
  rose: "#e8b9a6"
  rose-ink: "#8e3f27"
  storm: "#c2231b"
  chalk: "#eef2f7"
  chalk-2: "#e2e9f1"
  chalk-3: "#d3dce8"
  sheet-paper: "#f8fafc"
  field-well: "#ffffff"
  ink: "#0f1b33"
  slate: "#4d5b73"
  mist: "#c3cfe2"
  mist-dim: "#9fb0cc"
  hair: "rgba(238, 242, 247, 0.22)"
  hair-ink: "rgba(15, 27, 51, 0.14)"
typography:
  display:
    fontFamily: "Archivo, sans-serif"
    fontSize: "clamp(2.6rem, 5.4vw, 5.1rem)"
    fontWeight: 650
    lineHeight: 1.02
    letterSpacing: "-0.02em"
    fontVariation: "\"wdth\" 112"
  headline:
    fontFamily: "Archivo, sans-serif"
    fontSize: "clamp(2rem, 3.6vw, 3.3rem)"
    fontWeight: 650
    lineHeight: 1.02
    letterSpacing: "-0.02em"
    fontVariation: "\"wdth\" 112"
  title:
    fontFamily: "Archivo, sans-serif"
    fontSize: "clamp(1.9rem, 3vw, 2.6rem)"
    fontWeight: 650
    lineHeight: 1.02
    letterSpacing: "-0.02em"
    fontVariation: "\"wdth\" 112"
  body:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.55
    fontFeature: "\"ss01\""
  label:
    fontFamily: "Archivo, sans-serif"
    fontSize: "11px"
    fontWeight: 700
    letterSpacing: "0.14em"
    fontVariation: "\"wdth\" 125"
  button:
    fontFamily: "Archivo, sans-serif"
    fontSize: "13px"
    fontWeight: 700
    letterSpacing: "0.06em"
    fontVariation: "\"wdth\" 118"
  latin:
    fontFamily: "Bodoni Moda, serif"
    fontSize: "17px"
    fontWeight: 500
    letterSpacing: "0"
  data:
    fontFamily: "Geist Mono, ui-monospace, monospace"
    fontSize: "13px"
    fontFeature: "\"tnum\", \"zero\""
rounded:
  plate: "3px"
  hairline: "2px"
  avatar: "50%"
spacing:
  gutter: "clamp(16px, 4vw, 48px)"
  max: "1320px"
  section: "clamp(80px, 10vw, 140px)"
  frame: "14px"
  sheet: "20px"
components:
  button-signal:
    backgroundColor: "{colors.signal}"
    textColor: "{colors.ink}"
    typography: "{typography.button}"
    rounded: "{rounded.plate}"
    padding: "0 18px"
    height: "44px"
  button-signal-hover:
    backgroundColor: "{colors.signal-hover}"
    textColor: "{colors.ink}"
  button-line:
    backgroundColor: "transparent"
    textColor: "{colors.chalk}"
    typography: "{typography.button}"
    rounded: "{rounded.plate}"
    padding: "0 18px"
    height: "44px"
  button-line-hover:
    textColor: "{colors.signal}"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.button}"
    rounded: "{rounded.plate}"
    padding: "0 12px"
    height: "36px"
  install-card:
    backgroundColor: "{colors.chalk}"
    textColor: "{colors.ink}"
    typography: "{typography.data}"
    rounded: "{rounded.plate}"
    padding: "14px 16px"
  field-input:
    backgroundColor: "{colors.field-well}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.plate}"
    padding: "10px 12px"
  observation-sheet:
    backgroundColor: "{colors.sheet-paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.plate}"
    padding: "14px 20px"
  plate-mount:
    backgroundColor: "{colors.chalk}"
    textColor: "{colors.ink}"
    rounded: "{rounded.plate}"
    padding: "12px 12px 0"
  plate-window:
    backgroundColor: "{colors.atlas-2}"
    textColor: "{colors.chalk}"
  harness-switch-option:
    backgroundColor: "transparent"
    textColor: "{colors.slate}"
    padding: "6px 12px"
  harness-switch-option-active:
    backgroundColor: "{colors.atlas}"
    textColor: "{colors.chalk}"
  stamp-inked:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.chalk}"
    typography: "{typography.label}"
    padding: "2px 8px"
  app-bar:
    backgroundColor: "{colors.atlas}"
    textColor: "{colors.chalk}"
    height: "60px"
  app-nav-link:
    backgroundColor: "transparent"
    textColor: "{colors.mist}"
    rounded: "{rounded.plate}"
    padding: "8px 12px"
  app-nav-link-active:
    backgroundColor: "{colors.atlas-deep}"
    textColor: "{colors.chalk}"
  run-log:
    backgroundColor: "{colors.atlas-deep}"
    textColor: "{colors.chalk}"
    rounded: "{rounded.plate}"
  banner-change:
    backgroundColor: "{colors.rose}"
    textColor: "{colors.ink}"
  banner-storm:
    backgroundColor: "{colors.storm}"
    textColor: "#ffffff"
---

# Design System: Cloudly

## Overview

**Creative North Star: "The Cloud Atlas Station"**

Your VM is your observing station and every run is a classified, logged observation. The system borrows from two real artifacts: the chromolithograph plates of the 1896 International Cloud Atlas (flat printed inks, numbered plate frames, Latin genus names under each cloud) and WMO station-model notation (oktas sky-cover circles, the barometer's Fair, Change, Storm). Meteorology stays the second layer: every reading also carries its plain label ($1.42, Running, PR opened).

Committed atlas cobalt owns whole regions rather than tinting them. The marketing page descends through hard-stepped cobalt bands (high, middle and low cloud) to a chalk ground; the app inverts that, a cobalt bar over a chalk desk where records are filed as observation sheets. Surfaces are plates: chalk mounts with a thin ink rule, a cobalt window holding a live WebGL cloud printed in four flat inks with a stippled edge, and a log of single-line courses beneath. Density is that of a field notebook: tight hairline-ruled rows, tabular figures, generous section air between them.

The world rejects the category default of a near-black terminal hero over a feature-card grid. Logs run on deep cobalt, never black; status is drawn as weather, never as colored badges.

**Key Characteristics:**
- Cobalt fields in hard steps, never gradients; chalk plates and sheets sit on them.
- Four flat plate inks for clouds (slate, mist, chalk, rose), dithered at the edge.
- Expanded Archivo caps for plate and sheet headings, Bodoni Moda italic for Latin genus names, Geist for UI, Geist Mono for every number.
- International orange only on things you can press.
- Progress in oktas, spend on a barometer, terminal states stamped in solid ink.

## Colors

A cold, printed palette: four cobalts and three chalks carry the page, with one warm cloud-top rose, one action orange and one storm-flag red held in reserve.

### Primary
- **Atlas Cobalt** (atlas): The page field, the app bar, the selected harness option and the field focus border. It owns whole regions; it is never a thin accent.
- **Deep Atlas** (atlas-deep): The darker band, the run log's ground, the plate frame behind a canvas, and the active app-nav tab.
- **Altitude Cobalts** (atlas-2, atlas-3): The middle and low bands of the landing descent, and atlas-2 as the sky inside every plate window.

### Secondary
- **International Orange** (signal): The primary button, the range thumb, focus rings and hover borders on pressables. Text on it is ink, not white.
- **Orange, Lit** (signal-hover): Hover state of the signal button only.

### Tertiary
- **Cumulus Rose** (rose): Sunlit cumulus tops in the plate shader, the Change (80%) zone of the barometer and its banner, the done/PR course labels on cobalt, the live-run pulse, and text selection. The only warmth.
- **Rose Ink** (rose-ink): Rose's role on chalk, where rose itself is too light to read (course labels on mounts, the Change word on a light barometer).
- **Storm Flag** (storm): The maritime storm-warning red. The 100% hard stop (barometer Storm zone, storm banner, storm flag icon), failed runs, and blocking errors.

### Neutral
- **Chalk** (chalk): Body text on cobalt, the plate mount, the install card, the app desk, inked-stamp text on ink.
- **Chalk 2 / Chalk 3** (chalk-2, chalk-3): Row hover in the observation log; input and genus-picker strokes; skeleton tone.
- **Sheet Paper** (sheet-paper): The observation sheet and the run facts list, a half-step whiter than the desk.
- **Field Well** (field-well): The inside of inputs and unselected genus options.
- **Station Ink** (ink): Text on every chalk surface, plate-mount rules, inked stamps, text on orange.
- **Nimbus Slate** (slate): Secondary text, field labels and sheet headings on chalk.
- **Mist / Dim Mist** (mist, mist-dim): Secondary and tertiary text on cobalt.
- **Hairlines** (hair, hair-ink): 1px rules between courses, rows and facts; hair on cobalt, hair-ink on chalk.

### Named Rules
**The Orange Is Pressable Rule.** International orange appears only on things that respond to a press: buttons, the range control, focus rings and hover borders. It is never a heading color, a status, or decoration.

**The Two Warnings Rule.** Rose is Change (80% of the limit); storm red is the stop. The product's one danger signal never shares a color with its warning, and storm red never appears as decoration.

**The Rose-on-Chalk Rule.** On chalk surfaces rose text becomes rose-ink. Rose as fill (the Change banner, barometer arc) is fine on either ground.

## Typography

**Display Font:** Archivo, variable width axis (with sans-serif fallback)
**Body Font:** Geist (with ui-sans-serif, system-ui)
**Label/Mono Font:** Geist Mono for data; Archivo Expanded caps for labels
**Latin Font:** Bodoni Moda italic, for genus names only

**Character:** A widened grotesque sets the headlines and the stamped caps of plate frames, the way an atlas sets its plate legends; Bodoni italic names the clouds as a naturalist would; Geist does the plain talking, and every number is tabular mono.

### Hierarchy
- **Display** (650, wdth 112, clamp(2.6rem, 5.4vw, 5.1rem), 1.02, -0.02em): Landing hero headline, max 13ch, balanced. The closing headline runs larger (clamp(2.6rem, 6vw, 5.6rem), 11ch).
- **Headline** (650, wdth 112, clamp(2rem, 3.6vw, 3.3rem)): Landing section heads, max 18ch.
- **Title** (650, wdth 112, clamp(1.9rem, 3vw, 2.6rem)): App page heads; sign-in uses clamp(2.2rem, 3.6vw, 3.2rem).
- **Body** (400, 16px, 1.55, ss01): All UI copy. Ledes at 17-18.5px capped at 46-58ch; log rows at 14.5px; courses at 13px.
- **Label** (700, wdth 125, 11px, 0.14em, uppercase): Plate numbers (Plate I), mount and sheet headings, course kinds, barometer zone words, the reading in the app bar.
- **Button** (700, wdth 118, 13px, 0.06em, uppercase): Every button.
- **Latin** (Bodoni Moda italic 500, 15-22px): Genus and species names (Cumulus mediocris) in plates, logs, pickers and captions.
- **Data** (Geist Mono, tnum + slashed zero): Costs, timestamps, tool calls, the install command.

### Named Rules
**The Frame Label Rule.** Expanded caps label a frame (a plate's number, a sheet's name, a course's kind). They are never a kicker or eyebrow stacked above a headline.

**The Latin Is a Name Rule.** Bodoni italic only sets a cloud's classification, always next to the plain harness name. It never sets sentences or headings.

**The Tabular Money Rule.** Every cost, count and time is Geist Mono with tabular figures; estimates carry a tilde and say "estimated".

## Layout

One centered column, max 1320px, with a fluid gutter of clamp(16px, 4vw, 48px). The landing is a vertical descent of full-bleed bands, each a section with clamp(80px, 10vw, 140px) block padding: the hero band (copy at 0.82fr beside Plate I at 1fr, about 55% of the width), three altitude-tier strips of cloud, the station band, the barometer band, the dialects band, then the chalk ground holding the observation log and the close. Two-column sections (hero, station 1.35fr/0.65fr, spend 1fr/1fr) collapse to one column at 1080px.

The app is a 60px cobalt bar over a chalk desk; pages carry clamp(28px, 4vw, 56px) top padding and 96px bottom. Run detail is a log column beside a sticky 360px side plate; below 1080px the side plate moves above the log. Settings is two equal columns. At 760px the sheet grid, genus picker, sign-in split and empty state go single-column and the app nav wraps to its own row; at 640px the station figure swaps to its tall drawing and the dialects table becomes stacked groups.

Rhythm inside frames is tight: 10-14px frame padding, 8-14px row padding, 1px hairlines between every row.

## Elevation & Depth

Depth comes from color stepping first: cobalt bands step in value, chalk plates sit on cobalt, sheet paper sits on chalk. Shadows are soft and ambient, used only to lift a printed object (a plate, a sheet, a card) off its ground; they never signal hierarchy between siblings.

### Shadow Vocabulary
- **Plate lift** (`box-shadow: 0 18px 40px -18px rgba(8, 18, 45, 0.55), 0 2px 6px -2px rgba(8, 18, 45, 0.35)`): Plate mounts, the install card, the plate frame.
- **Card lift** (`box-shadow: 0 10px 24px -14px rgba(15, 27, 51, 0.35), 0 1px 2px rgba(15, 27, 51, 0.12)`): Observation sheets, the run log, the settings reading, the mail preview.
- **Signal glow** (`box-shadow: 0 6px 16px -8px rgba(255, 90, 31, 0.7)`): The signal button at rest; removed on press and when disabled.
- **Field focus** (`box-shadow: 0 0 0 3px rgba(31, 63, 140, 0.18)`): Inputs on focus, with an atlas border.

### Named Rules
**The Hard Steps Rule.** Sky bands and plate inks change in hard steps. No gradient ever fills a band, a plate or a cloud.

## Shapes

A single small radius (3px) on every plate, sheet, card, button, input and chip, so objects read as cut paper rather than app tiles. 2px for the focus outline and skeleton bars; circles only for the oktas glyph, the live dot and avatars. Borders are 1px hairlines; a 1px solid ink rule frames a plate mount's head, window and foot, and table heads take a 1.5px rule. Segmented controls (harness switch, genus picker) are one bordered box divided by internal hairlines, never separate pills.

## Components

### Buttons
Stamped and plain: expanded uppercase labels on a barely rounded slab.
- **Shape:** Small radius (3px), 44px minimum height (52px full-width on sign-in), 18px side padding, 16px SVG icon with a 10px gap.
- **Signal (primary):** International orange with ink text and the signal glow. One per view, on the action that matters (copy install, start run, sign in).
- **Hover / Focus:** Signal lightens to signal-hover; press nudges down 1px and drops the glow. Focus is a 2px orange outline offset 3px. Transitions are 160ms on the ease-out curve.
- **Line:** Transparent with a currentColor border; on hover border and text turn orange.
- **Quiet:** 36px, hair-ink border, ink text, orange border on hover. For secondary actions on chalk.
- **Disabled:** 45% opacity, no glow, not-allowed cursor.

### Chips
- **Harness switch:** A segmented row in a hairline box; options are 12.5px medium text separated by hairlines. Selected is chalk on cobalt, or cobalt on chalk inside a mount.
- **Providers:** Hairline-bordered 3px tags with chalk text on cobalt.

### Cards / Containers
- **Observation sheet:** The composer and the record share one anatomy: sheet paper, hair-ink border, card lift, a sheet head (caps name in slate on the left, an oktas glyph or action on the right), a three-column grid of fields divided by hairlines, and a foot row. Fields are 16px 20px.
- **Install card:** Chalk slab with plate lift, the command in mono with a slate prompt, and the signal button docked flush on the right. Inverts to cobalt in the close.
- **Facts list:** Sheet paper, hairline rows, slate term left, value right.
- **Consequence card:** Hairline box on cobalt whose border turns rose at Change and storm (with a storm tint) at Storm.

### Inputs / Fields
- **Style:** Field-well white, 1px chalk-3 stroke, 3px radius, 10px 12px padding, 15px ink text; label above in 12px semibold slate.
- **Focus:** Border turns atlas with the 3px atlas field-focus halo; no outline.
- **Genus picker:** A three-up segmented radio: Latin genus, harness name, cost line. Checked fills atlas with chalk text; keyboard focus is an inset orange outline.
- **Error:** Storm border and text on a pale storm wash.

### Navigation
- **Landing topbar:** Wordmark (Archivo wdth 125, 800, 17px, with the mark) left; 14px mist links that brighten to chalk on hover; a line button for sign-in.
- **App bar:** Cobalt, 60px. Nav tabs are 14px mist text, 8px 12px; the current page is chalk on deep atlas. The right side holds the limit reading (oktas glyph, caps state word, mono spend) whose border turns rose or storm with the budget, the avatar, and an underlined sign-out. Below 760px the nav wraps to its own row.
- **Budget banner:** Full-width under the bar at Change (rose, ink text) or Storm (storm red, white text, storm flag).

### Plate Mount (signature)
The atlas plate: a chalk mount with plate lift and 12px padding; a head ruled in ink with the caps plate number (Plate I) and a control or state; a cobalt window holding the WebGL cloud; then courses, a foot, and a caption with the Latin name. The cloud is ray-marched and printed in four flat inks (slate, mist, chalk, rose for sunlit tops only), with coverage resolved to ink or bare sky through an ordered dither. Its genus (cumulus, altocumulus, cirrus) follows the harness; its growth follows run progress. Every canvas has a text fallback and an aria label.

### Courses (signature)
The run log as a stack of single-line courses, one event per course: a mono timestamp, a caps kind, and the body, hairline-ruled. Tool calls and results set in mono; done and PR kinds take rose (rose-ink on chalk). New courses condense in over 520ms (rise 6px, fade, unblur). In the run detail the log sits on deep atlas and wraps bodies instead of truncating.

### Oktas Glyph and Barometer (signature)
Run progress is the WMO sky-cover circle filled in eighths (0 not started, 8 finished; crossed for sky obscured, meaning failed). Spend is an aneroid barometer: a dim Fair arc to 80%, a rose Change arc to 100%, a storm arc beyond, a stroked needle easing over 600ms, zone words outside the dial, and the storm flag beside Storm. A compact version without ticks sits in plate feet.

### Inked Stamp
Status is two-state: plain semibold text while in progress, then stamped solid (ink ground, chalk caps; inverted on cobalt bands) once terminal.

## Do's and Don'ts

### Do:
- **Do** let atlas cobalt own whole bands and the app bar; step between atlas, atlas-deep, atlas-2 and atlas-3 in hard edges.
- **Do** put every interactive primary action in international orange with ink text, and nothing else in orange.
- **Do** print clouds in the four plate inks (slate, mist, chalk, rose) with a dithered edge, inside a numbered plate mount with a Latin caption.
- **Do** show run progress with the oktas glyph and spend with the barometer, always beside the plain label and the mono figure.
- **Do** label frames with Archivo Expanded caps (11px, 0.14em) and set genus names in Bodoni Moda italic next to the harness name.
- **Do** use rose for Change (80%) and storm red for the stop; switch rose text to rose-ink on chalk.
- **Do** keep every radius at 3px and every rule at 1px hairline.
- **Do** honor reduced motion: the plate holds still, courses appear without condensing.

### Don't:
- **Don't** fill a band, plate or cloud with a gradient or smooth shading.
- **Don't** set logs or heroes on near-black; logs run on deep atlas.
- **Don't** use orange for status, headings or decoration.
- **Don't** let storm red mark the 80% warning or appear as an accent.
- **Don't** stack a caps kicker or eyebrow above a headline; caps label frames only.
- **Don't** draw status as colored pill badges; use oktas, the stamp, or plain text.
- **Don't** use rose outside sunlit cloud tops, Change, done/PR kinds and the live pulse.
- **Don't** round corners past 3px or split segmented controls into separate pills.
