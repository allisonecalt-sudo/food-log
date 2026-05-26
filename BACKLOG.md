# food-log — Backlog

Features Allison has sketched but explicitly deferred. Don't pre-build — wait for her to say "let's ship it."

---

## Time flexibility (deferred 2026-05-24)

**Trigger:** Mounjaro stretches meals across hours. She started a drinkable yogurt at 10:43, was still sipping at 14:29. A single timestamp doesn't fit her reality.

**Her own framing 2026-05-24:** _"this will be a thing later"_ — explicitly parking it. She wants BOTH of these together, not either/or:

1. **Time range** — meal has a start AND an end (or start + duration). Closing the meal stamps the end.
2. **"Still eating" / "eating slowly" status** — explicit pace marker, separate from the time range. Some meals get sipped for hours by design; some are just open because she forgot to close them. The status differentiates _intentionally slow_ from _forgot to mark done_.

**Sketch of the schema:**

```sql
alter table public.meals
  add column finished_at timestamptz,           -- nullable; null = still going
  add column pace text;                         -- 'normal' | 'slowly' | 'grazing' | null
```

**Sketch of the UI:**

- New meal default: starts now, `finished_at = null`, `pace = null`.
- Home strip: meals without `finished_at` show "from 10:43, still going" with a **"Just finished"** button. Meals with both show "10:43 – 14:29 (eating slowly)".
- Optional pace pill on the meal sheet: `Normal / Slowly / Grazing`.
- Edit sheet exposes both times + pace.

**Why deferred:** schema migration + UI change + queue/IDB work for partial-state meals. Not a 30-min build. Hold until she asks.

---

## Skip around days (deferred 2026-05-24)

**Trigger:** Current history is an accordion (Today / Yesterday / weekday / dated). She wants to jump straight to a specific date without scrolling.

**Sketch:** date picker at the top of the history section. Pick a date → scroll the accordion to that date or show only that day.

**Why deferred:** she went to book her doctor appointment instead of asking for it. Comes back when she wants.

---

## AI analysis on demand (already wired, no build needed)

She explicitly said 2026-05-24: _"i'm not sure we need hooks yet for now i can just tell you when to analyze."_

So: **no automation hooks.** When she says "Claude, analyze my food log" (or any equivalent), pull from Supabase (`meals`, `meal_photos`, `weight_log`) + workout data (`workout_sessions`) + body-comp narrative in `self/health.md`, fetch photos from the public bucket URLs, and synthesize. The first analysis happened 2026-05-24 at ~2:30pm for today's two entries — drinkable yogurt + 2 eggs + spelt rice cakes — and surfaced the morning-protein gap relative to her 25-30g/meal leucine threshold.

Pattern to reuse for future analyses:

- Photos are at `https://hpiyvnfhoqnnnotrmwaz.supabase.co/storage/v1/object/public/food-photos/{path}`
- Read via curl to `/c/tmp/` then Read tool (which handles images).
- Vibe-level read, not calorie audit. Map to her targets (~105g protein/day, ~25-30g/meal).
- Cross-reference with [memory: user_body_signal_clothes_not_scale] and the May 24 holistic research.

---

## Future / blue-sky (not asked for, just noted)

- AI vision auto-captions on photo upload (would write to `meals.description` as a default the user can edit).
- Weekly digest: every Sunday morning, "here's what I ate / how the weight trend looks / one observation" — but only if she asks for it; no hooks per her rule.
- Export / share specific days for the dietitian appointment.
