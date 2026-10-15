---
name: Cloudly
description: Coding agents on a server you already own. Calm, precise developer tool; one meaningful 3D model of the user's own cloud.
colors:
  light:
    bg: "#f6f7f9"
    surface: "#fcfcfd"
    surface-2: "#eff1f4"
    surface-3: "#e6e9ee"
    border: "#e1e4e9"
    border-strong: "#cdd2da"
    text: "#11151b"
    text-2: "#4f5866"
    text-3: "#7d8592"
    accent: "#e9561c"
    ok: "#1d8049"
    warn: "#9a6400"
    danger: "#c8302a"
  dark:
    bg: "#0c0e11"
    surface: "#13161a"
    surface-2: "#1a1e23"
    surface-3: "#22272d"
    border: "#252a31"
    border-strong: "#353c45"
    text: "#eceef1"
    text-2: "#a3aab5"
    text-3: "#707884"
    accent: "#f26a35"
    ok: "#47bf7a"
    warn: "#e2a845"
    danger: "#f0605a"
typography:
  sans: "Geist (local), ui-sans-serif, system-ui"
  mono: "Geist Mono (local): commands, code, branch names, small figures"
rounded:
  control: "10px (buttons, inputs)"
  box: "14px (panels, cards, install card)"
  bubble: "18px (composer, user messages)"
  pill: "999px (chips, status pills, send button)"
icons: "@phosphor-icons/react, regular weight, bold for status glyphs"
---

# Design System: Cloudly

## Overview

A calm developer tool. Neutral cool greys, one accent, Geist throughout, and generous space. Light and dark follow `prefers-color-scheme`; every color is a token in `app/globals.css` (`:root` and its dark override), so nothing hardcodes a hex outside that block except the white text on solid status fills.

The one expressive element is the **cloud model** (`components/cloud-scene.tsx`): a CSS 3D model of the user's own cloud account. One VM holds Web + API, Postgres, the key gateway, the worker and a throwaway sandbox; outside it sit the browser, the model API, GitHub and "anywhere else". It exists because it explains the product: steps light the parts doing the work and beams show what crosses the boundary (the placeholder key swapped at the gateway, blocked egress hitting the wall, the PR leaving through the worker). It is built from DOM, not WebGL, so labels stay crisp, selectable and themeable. Drag or arrow keys turn it; double-click resets.

It appears in two places only:
- **Landing** (`components/run-story.tsx`): beside the hero it autoplays a run; as the five story steps scroll past, it follows the step in the middle of the viewport. Below 960px it sits under the hero and the steps read as a plain list.
- **Setup**: the model fills in as setup connects each piece (GitHub is absent until the app exists).

## Color rules

- **One accent.** Signal orange marks live state (running spinner, lit nodes, travelling packets, active step) and focus rings. Primary buttons are the foreground color (ink on light, chalk on dark), not orange.
- **Status colors mean status.** `ok` for succeeded and PR opened, `warn` for the 80% spend warning, `danger` for failure, blocked egress and the 100% stop. Never decorative.
- Links in prose use `accent-ink`, the darker or lighter accent that passes contrast on the page background.

## Typography

Geist for everything readable; Geist Mono for commands, code, repo and branch names and small figures. Large money figures use Geist with tabular digits (mono looks spaced out at display size). Headings are 600 weight with tight negative tracking. No eyebrows or caps kickers above headings.

## Layout

- Landing: max 1200px, sticky blurred top bar, story grid (copy 0.9fr, model 1.1fr), then spend, agents, close. Sections are separated by a hairline, not by background bands.
- App: a 272px sidebar (sessions grouped Today / Yesterday / Previous 7 days / Older, spend meter, settings, account) and a main column. Below 900px the sidebar becomes a drawer behind a 56px bar. Ctrl/Cmd+K starts a new session.
- Session: a sticky header (title, repo, branch, agent, model; context ring, total cost and PR on the right), an 800px thread, and a docked composer.
- Settings: label column (220px) beside content panels; collapses to one column at 800px.

## Components

- **Composer**: the same object on the new-session page and in a session. A rounded 18px box with an auto-growing textarea (`field-sizing: content`) and a bar of pills (repo, branch, agent) plus a round send button that turns into Stop while a turn runs. Slash commands open a listbox above it with arrow, Enter, Tab and Escape.
- **Turn**: the user's message is a right-aligned bubble; the agent's reply is plain prose. Tool calls fold into one activity line ("Ran 2 commands, read a file") that expands into the list; while live it shimmers with the current call. Reasoning folds under "Reasoning". A quiet footer carries status, elapsed time, cost (with `est.` for estimates) and a PR chip.
- **Status glyphs** (`components/status.tsx`): dashed circle queued, spinning notch running, check or PR mark succeeded, X failed, prohibit cancelled.
- **Spend**: a bar with the 80% mark in the sidebar and settings; on the landing a styled range input drives the outcome panel.

## Motion

Transitions are 160 to 900ms on `cubic-bezier(0.16, 1, 0.3, 1)`. Motion is used for state only: the model's beams and lift, the live shimmer, the spinner, step emphasis. `prefers-reduced-motion` stops autoplay, packets, shimmer and spin, and parks packets mid-beam.

## Don'ts

- Don't add decorative 3D or animation that doesn't explain something the product does.
- Don't use orange for headings, decoration or status.
- Don't use em or en dashes in UI copy.
- Don't name the Claude harness "Claude Code"; it is "Claude Agent".
