# Food Log

Allison's food log — phone PWA, third in the personal-app family (budget-2026,
workout-tracker, food-log).

## What this is — v1.6

Her words (May 2026): _"I wanted to be able to either take a picture or describe
what I ate 'cause like let's say I just ate and I didn't take a picture so I
wanna be able to describe it and also I wanna be able to put in multiple pictures
per meal and write or voice to text whatever."_

And then (May 24, 2026): _"I can't log on the day so there should be an option
to either try to do times and like estimate what time things were ... I don't
like logging calories ... I wanna kinda just see if we can make a more just
like general vibe of what i'm eating. And also maybe we should add weight too
then to the food tracker?"_

- One screen. Two sibling pills at the top — **➕ Meal** + **⚖ Weight**.
- A meal can have 0+ photos AND/OR a written/voice-to-text description (at
  least one is required to save).
- **Fuzzy time chips** in both sheets: Now / Morning / Midday / Afternoon /
  Evening / Late / Custom. One-tap. Custom expands the date+time inputs for
  the rare precise case.
- Multiple photos per meal — tap **📷 Add photo** as many times as you want;
  reorder with ↑/↓; remove with ✕.
- Voice-to-text just works — tap the mic button on the iOS/Android keyboard
  inside any textarea.
- Today's strip shows every meal from today with time, photo strip, and a
  description preview.
- History below collapses prior days (Yesterday, weekday, then dated), last 30
  on the home screen.
- **Weight section** below meals on home: sparkline of recent trend + last 5
  entries + Show-all toggle. New entries pre-fill the last logged weight so
  she just nudges it.
- Tap any meal or weight row → full-screen detail (edit, hold-to-delete).
- Offline-safe: failed meal AND weight saves queue in IndexedDB and drain on
  next online tick.

## What this isn't (yet)

No macros, no protein/leucine tracking, no AI vision analysis. Those layer in
v2 once there's enough data to be useful. The `meals.description` column,
structured `{yyyy}/{mm}/{uuid}.jpg` photo path, and `weight_log` table are the
v2-ready hooks for AI-guess-the-calories from accumulated context.

## Live

https://allisonecalt-sudo.github.io/food-log/

## Stack

- TypeScript strict (`noImplicitAny`, `strictNullChecks`, etc.)
- ESLint + Prettier
- Husky pre-commit running format:check + lint + build + test
- Playwright smoke tests
- GitHub Actions CI → GitHub Pages deploy
- PWA (manifest + service worker + maskable icons) — installable on iPhone +
  Android home screens

## Supabase

- Project: `hpiyvnfhoqnnnotrmwaz` (shared with budget-2026 + workout-tracker).
- Tables:
  - `meals` (id, eaten_at, description, created_at)
  - `meal_photos` (id, meal_id, photo_path, position, created_at) — 1:N with
    `ON DELETE CASCADE`
  - `weight_log` (id, measured_at, weight_kg, notes, created_at) — sibling to
    meals, parallel surface
- Storage bucket: `food-photos` (public, RLS allows anon read + write —
  single-user app pattern).
- See `setup.sql` for the schema + RLS policies. New tables applied via the
  Supabase Management API at build time — no SQL-editor paste required.

## Install on phone

**iPhone (Safari):**

1. Open https://allisonecalt-sudo.github.io/food-log/
2. Tap Share → Add to Home Screen → Add.

**Android (Chrome):**

1. Open https://allisonecalt-sudo.github.io/food-log/
2. Tap the menu (⋮) → Install app (or Add to Home screen).

## Local dev

```bash
npm install
npm run build      # tsc → dist/app.js
npm run serve      # http://localhost:3000
npm run lint
npm run test       # Playwright
```

Pre-commit hook runs the full gate (format:check + lint + build + test).
