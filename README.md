# Food Log

Allison's food log — phone PWA, third in the personal-app family (budget-2026,
workout-tracker, food-log).

## What this is — v1.5

Her words (May 2026): _"I wanted to be able to either take a picture or describe
what I ate 'cause like let's say I just ate and I didn't take a picture so I
wanna be able to describe it and also I wanna be able to put in multiple pictures
per meal and write or voice to text whatever."_

- One screen. Tap **➕ Add a meal** → modal sheet → time + textarea + photos →
  save.
- A meal can have 0+ photos AND/OR a written/voice-to-text description (at
  least one is required to save).
- Multiple photos per meal — tap **📷 Add photo** as many times as you want;
  reorder with ↑/↓; remove with ✕.
- Voice-to-text just works — tap the mic button on the iOS/Android keyboard
  inside the textarea.
- Time auto-stamps to "now" but is editable (forgot to log earlier? change it).
- Today's strip shows every meal from today with time, photo strip, and a
  description preview.
- History below collapses prior days (Yesterday, weekday, then dated), last 30
  on the home screen.
- Tap a meal → full-screen detail (all photos, full description, edit, hold-to-
  delete).
- Offline-safe: failed saves queue the entire meal (description + photos) as
  one unit in IndexedDB and drain on next online tick.

## What this isn't (yet)

No macros, no protein/leucine tracking, no AI vision analysis. Those layer in
v2 once there's enough data to be useful. The `meals.description` column +
structured `{yyyy}/{mm}/{uuid}.jpg` photo path are the v2-ready hooks.

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
- Tables: `meals` (id, eaten_at, description, created_at) +
  `meal_photos` (id, meal_id, photo_path, position, created_at), 1:N with
  `ON DELETE CASCADE`.
- Storage bucket: `food-photos` (public, RLS allows anon read + write —
  single-user app pattern).
- See `setup.sql` for the schema + RLS policies.

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
