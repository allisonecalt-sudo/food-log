# Food Log

Allison's photo-based food log — phone PWA, third in the personal-app family
(budget-2026, workout-tracker, food-log).

## What this is

v1 scope (her words): _"everything that day for now, food and time, that's it.
As we gain data we can improve."_

- One screen. Tap the camera button → snap a meal → photo + auto-timestamp
  saves to Supabase Storage.
- Today's strip shows every photo from today with `HH:mm` time labels.
- History below collapses prior days (Yesterday, weekday, then dated), last 30
  on the home screen.
- Tap a thumbnail = full-screen view + hold-to-delete.
- Offline-safe: failed uploads queue in IndexedDB and drain on next online tick.

## What this isn't (yet)

No macros, no protein/leucine tracking, no AI vision analysis, no typing. Those
layer in v2 once there's enough data to be useful. The `notes` column on
`food_entries` and the structured `{yyyy}/{mm}/{uuid}.jpg` photo path are the
v2-ready hooks.

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
- Table: `food_entries` (id, eaten_at, photo_path, notes, created_at).
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
