# Lessons

Cloudly sees what goes wrong in a repo's sessions. **Lessons** turns that into rules for the repo's notes, so the same mistake doesn't happen twice.

## What it learns from

- **The reviewer's findings**, blocking and suggestions (and which you dismissed, which count against a lesson, not for it).
- **Turns you rewound**, and what you asked for instead.
- **What you said after a turn**: corrections like "no, don't edit the generated client" come first.
- **Checks** that failed after a change, and **CI** Cloudly had to fix.

## How it works

On the Lessons page, pick a repo and **Look for lessons**. An agent (the repo's reviewer if it has one) reads all of that, numbered, checks it against the code, and writes up to six lessons, each a short rule with why and what it's based on. It leaves out generic advice, one-offs, and anything the notes already say or you turned down before. It needs at least 3 things that went wrong since the last look; with fewer it doesn't start an agent at all.

Each lesson waits for you. Edit it if you like, then **Add to the repo's notes**, or **Not this one**. Kept lessons go under "Learned from earlier sessions" in the repo's [shared context](/docs/shared-context) notes, which every agent working on the repo reads at the start of each turn, Cloudly's and your editor's alike. Keeping one turns shared context on for the repo, if it was off.

Tick **Every week** and Cloudly looks on its own, once a week, when at least 5 things have gone wrong since the last look. Each look is one agent turn and costs like one.
