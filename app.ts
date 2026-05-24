/**
 * food-log — v1.6.
 *
 * v1.5 scope (Allison): meal = atom. A meal has 0+ photos AND/OR a
 * written/voice-to-text description. App enforces "at least one of the two."
 *
 * v1.6 adds (Allison 2026-05-24):
 *
 *   "I can't log on the day so there should be an option to either try to do
 *    times and like estimate what time things were or also to just dump and
 *    say whatever I ate ... I don't like logging calories ... so I wanna kinda
 *    just see if we can make a more just like general vibe of what I'm eating
 *    and then ... once we have some data you start ... guessing the calories"
 *
 *   "and also maybe we should add weight too then to the food tracker?"
 *
 * Translates to two coupled changes:
 *
 *  1. FUZZY TIME CHIPS in the meal-entry sheet. One-tap chips —
 *     Now / Morning / Midday / Afternoon / Evening / Late / Custom —
 *     replace the always-visible date+time inputs from v1.5.1. The split
 *     inputs still exist, just hidden under the Custom chip. Default = Now.
 *
 *  2. WEIGHT LOG as a sibling surface. New `weight_log` Supabase table,
 *     parallel to meals. Header has two pill buttons — `➕ Meal` and `⚖ Weight`.
 *     Weight quick-sheet = same chip row + one numeric input + optional notes.
 *     Default weight pre-fills with last logged value (she just nudges).
 *     Weight section below meals on home, mirrors meal-card UX.
 *
 * Storage: Supabase tables `meals` + `meal_photos` (1:N) + `weight_log`.
 * Photos in Storage bucket `food-photos`. Offline writes queue per surface
 * in IndexedDB and drain on next online tick.
 *
 * v2-ready hooks (unchanged from v1.5):
 *   - photo path structured `{yyyy}/{mm}/{uuid}.jpg` so vision models can
 *     fetch deterministically via Storage public URL
 *   - `meals.description` for AI captioning / fusion with vision
 *   - `weight_log` ready to plug into the same future analysis layer
 */

// ─── Config ─────────────────────────────────────────────────────────────────

const SB_URL = 'https://hpiyvnfhoqnnnotrmwaz.supabase.co';
const SB_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhwaXl2bmZob3Fubm5vdHJtd2F6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI0NzIwNDEsImV4cCI6MjA4ODA0ODA0MX0.AsGhYitkSnyVMwpJII05UseS_gICaXiCy7d8iHsr6Qw';

const BUCKET = 'food-photos';
const MEALS_TABLE = 'meals';
const PHOTOS_TABLE = 'meal_photos';
const WEIGHT_TABLE = 'weight_log';
const HISTORY_DAYS = 30;
const WEIGHT_PREVIEW_COUNT = 5; // last N weights shown collapsed on home
const IDB_NAME = 'food-log-queue';
const IDB_STORE_MEALS = 'pending-meals';
const IDB_STORE_WEIGHTS = 'pending-weights'; // v1.6 add

// ─── Types ──────────────────────────────────────────────────────────────────

interface MealPhoto {
  id: string;
  photo_path: string;
  photo_url: string;
  position: number;
}

interface Meal {
  id: string;
  eaten_at: string; // ISO timestamp
  description: string | null;
  photos: MealPhoto[];
  pending: boolean; // true if still queued locally
}

interface PendingPhotoBlob {
  // photo_path is the storage object key chosen at queue-time so the optimistic
  // tile and the eventual server row reference the same URL.
  photo_path: string;
  blob: Blob;
  position: number;
}

interface PendingMeal {
  localId: string;
  eaten_at: string;
  description: string | null;
  photos: PendingPhotoBlob[];
}

interface WeightEntry {
  id: string;
  measured_at: string;
  weight_kg: number;
  notes: string | null;
  pending: boolean;
}

interface PendingWeight {
  localId: string;
  measured_at: string;
  weight_kg: number;
  notes: string | null;
}

// State the meal-entry sheet manages while it's open.
interface DraftPhoto {
  // The picked file is held in memory; the photo_path is pre-allocated so the
  // optimistic UI and the later upload share the same key.
  file: File;
  photo_path: string;
  blobUrl: string; // URL.createObjectURL preview
}

// ─── Fuzzy time chips ───────────────────────────────────────────────────────

// One-tap chips that cover the 95% case ("eaten this morning" / "afternoon").
// Custom expands the date+time inputs underneath for precision when she wants
// it (the rare 5%).
type ChipId = 'now' | 'morning' | 'midday' | 'afternoon' | 'evening' | 'late' | 'custom';

interface ChipDef {
  id: ChipId;
  label: string;
  // For chips other than 'now' and 'custom', the hour they snap to today
  // (local wall-clock). 'now' resolves at tap-time, 'custom' is user-driven.
  hour?: number;
  minute?: number;
}

const CHIP_DEFS: readonly ChipDef[] = [
  { id: 'now', label: 'Now' },
  { id: 'morning', label: 'Morning', hour: 9, minute: 0 },
  { id: 'midday', label: 'Midday', hour: 12, minute: 30 },
  { id: 'afternoon', label: 'Afternoon', hour: 15, minute: 0 },
  { id: 'evening', label: 'Evening', hour: 19, minute: 0 },
  { id: 'late', label: 'Late', hour: 22, minute: 0 },
  { id: 'custom', label: 'Custom' },
];

// Given an ISO timestamp, decide which non-custom chip matches it. Used when
// re-opening the sheet for an EDIT — if eaten_at = 09:15 today, pre-select the
// Morning chip; if it's a wildly off-hours time, fall back to Custom.
//
// Match window: ±90 minutes from the chip's anchor hour AND the date is today.
// Off-today entries always fall to Custom (no chip means "today at X").
function chipForIso(iso: string): ChipId {
  const d = new Date(iso);
  const today = new Date();
  if (
    d.getFullYear() !== today.getFullYear() ||
    d.getMonth() !== today.getMonth() ||
    d.getDate() !== today.getDate()
  ) {
    return 'custom';
  }
  const totalMin = d.getHours() * 60 + d.getMinutes();
  for (const c of CHIP_DEFS) {
    if (c.id === 'now' || c.id === 'custom' || c.hour === undefined) continue;
    const anchor = c.hour * 60 + (c.minute ?? 0);
    if (Math.abs(totalMin - anchor) <= 90) return c.id;
  }
  return 'custom';
}

// Turn a chip (other than 'custom') into an ISO timestamp.
function isoForChip(c: ChipId): string {
  if (c === 'custom') {
    // Caller should not invoke this for custom; defensive — return now.
    return new Date().toISOString();
  }
  if (c === 'now') return new Date().toISOString();
  const def = CHIP_DEFS.find((d) => d.id === c);
  const d = new Date();
  if (def && def.hour !== undefined) {
    d.setHours(def.hour, def.minute ?? 0, 0, 0);
  }
  return d.toISOString();
}

function chipLabel(c: ChipId): string {
  return CHIP_DEFS.find((d) => d.id === c)?.label ?? 'Now';
}

// ─── Sheet states ───────────────────────────────────────────────────────────

interface SheetState {
  mealId: string | null; // null = new meal; otherwise editing
  chip: ChipId; // active fuzzy-time chip
  eatenAtLocal: string; // value of <input type=datetime-local> under Custom
  description: string;
  // For an edit, existing photos already on the server that the user hasn't
  // removed. Removed ones go to removedExistingIds.
  existingPhotos: MealPhoto[];
  removedExistingIds: Set<string>;
  draftPhotos: DraftPhoto[]; // newly picked, not yet uploaded
}

interface WeightSheetState {
  weightId: string | null; // null = new entry; otherwise editing
  chip: ChipId;
  measuredAtLocal: string;
  weightKg: string; // raw string so blank/invalid is representable
  notes: string;
}

// ─── DOM helpers ────────────────────────────────────────────────────────────

function $(sel: string, root: ParentNode = document): HTMLElement | null {
  return root.querySelector(sel);
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: (Node | string)[] = []
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on') && typeof v === 'string') {
      // not used — kept type-safe by only supporting string attributes
    } else {
      e.setAttribute(k, v);
    }
  }
  for (const c of children) {
    e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return e;
}

// ─── UUID (no node:crypto needed in the browser) ─────────────────────────────

function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  // Fallback for older browsers — RFC4122 v4-ish.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ─── State ──────────────────────────────────────────────────────────────────

let meals: Meal[] = [];
let weights: WeightEntry[] = [];
let lightboxMeal: Meal | null = null;
let weightLightbox: WeightEntry | null = null;
let sheet: SheetState | null = null;
let weightSheet: WeightSheetState | null = null;
let weightHistoryOpen = false;

// ─── Supabase URLs ──────────────────────────────────────────────────────────

function publicPhotoUrl(path: string): string {
  return `${SB_URL}/storage/v1/object/public/${BUCKET}/${path}`;
}

function buildPhotoPath(now: Date): string {
  const yyyy = now.getFullYear().toString();
  const mm = (now.getMonth() + 1).toString().padStart(2, '0');
  return `${yyyy}/${mm}/${uuid()}.jpg`;
}

// ─── Date helpers ───────────────────────────────────────────────────────────

function formatTime(iso: string): string {
  const d = new Date(iso);
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  return `${hh}:${mm}`;
}

function startOfLocalDay(iso: string): number {
  const d = new Date(iso);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const that = new Date(d);
  that.setHours(0, 0, 0, 0);
  const diffDays = Math.round((today.getTime() - that.getTime()) / 86_400_000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) {
    const weekday = d.toLocaleDateString(undefined, { weekday: 'long' });
    return weekday;
  }
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Convert ISO → "YYYY-MM-DDTHH:mm" local for <input type=datetime-local>.
function isoToDatetimeLocal(iso: string): string {
  const d = new Date(iso);
  const yyyy = d.getFullYear().toString();
  const mo = (d.getMonth() + 1).toString().padStart(2, '0');
  const da = d.getDate().toString().padStart(2, '0');
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  return `${yyyy}-${mo}-${da}T${hh}:${mm}`;
}

// Inverse — interprets the value as local wall-clock time, returns ISO.
function datetimeLocalToIso(local: string): string {
  // Browsers give "2026-05-24T13:42" with no timezone. new Date() parses that
  // as local time, which is what we want.
  return new Date(local).toISOString();
}

function previewDescription(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= 80) return trimmed;
  return trimmed.slice(0, 77) + '…';
}

// ─── IndexedDB offline queue ────────────────────────────────────────────────

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    // v3: adds pending-weights store.
    const req = indexedDB.open(IDB_NAME, 3);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE_MEALS)) {
        db.createObjectStore(IDB_STORE_MEALS, { keyPath: 'localId' });
      }
      if (!db.objectStoreNames.contains(IDB_STORE_WEIGHTS)) {
        db.createObjectStore(IDB_STORE_WEIGHTS, { keyPath: 'localId' });
      }
      // Best-effort: nuke v1 store so its photo-only entries don't linger.
      if (db.objectStoreNames.contains('pending')) {
        db.deleteObjectStore('pending');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function queuePendingMeal(item: PendingMeal): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE_MEALS, 'readwrite');
    tx.objectStore(IDB_STORE_MEALS).put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function readPendingMeals(): Promise<PendingMeal[]> {
  const db = await openDb();
  const result = await new Promise<PendingMeal[]>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE_MEALS, 'readonly');
    const req = tx.objectStore(IDB_STORE_MEALS).getAll();
    req.onsuccess = () => resolve(req.result as PendingMeal[]);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return result;
}

async function removePendingMeal(localId: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE_MEALS, 'readwrite');
    tx.objectStore(IDB_STORE_MEALS).delete(localId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function queuePendingWeight(item: PendingWeight): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE_WEIGHTS, 'readwrite');
    tx.objectStore(IDB_STORE_WEIGHTS).put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function readPendingWeights(): Promise<PendingWeight[]> {
  const db = await openDb();
  const result = await new Promise<PendingWeight[]>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE_WEIGHTS, 'readonly');
    const req = tx.objectStore(IDB_STORE_WEIGHTS).getAll();
    req.onsuccess = () => resolve(req.result as PendingWeight[]);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return result;
}

async function removePendingWeight(localId: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE_WEIGHTS, 'readwrite');
    tx.objectStore(IDB_STORE_WEIGHTS).delete(localId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

// ─── Supabase API ───────────────────────────────────────────────────────────

async function uploadPhoto(blob: Blob, path: string): Promise<void> {
  const res = await fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${path}`, {
    method: 'POST',
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': blob.type || 'image/jpeg',
      'x-upsert': 'true',
    },
    body: blob,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`upload failed (${res.status}): ${text}`);
  }
}

async function deleteStorageObject(path: string): Promise<void> {
  // Best-effort — tolerate failure (orphan storage is harmless).
  try {
    await fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${path}`, {
      method: 'DELETE',
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
    });
  } catch (err) {
    console.warn('[food-log] storage delete failed:', err);
  }
}

interface MealRow {
  id: string;
  eaten_at: string;
  description: string | null;
}

interface MealPhotoRow {
  id: string;
  meal_id: string;
  photo_path: string;
  position: number;
}

interface WeightRow {
  id: string;
  measured_at: string;
  weight_kg: number | string; // PostgREST returns numeric as string sometimes
  notes: string | null;
}

async function insertMealRow(eatenAt: string, description: string | null): Promise<MealRow> {
  const res = await fetch(`${SB_URL}/rest/v1/${MEALS_TABLE}`, {
    method: 'POST',
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({ eaten_at: eatenAt, description }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`meal insert failed (${res.status}): ${text}`);
  }
  const rows = (await res.json()) as MealRow[];
  return rows[0];
}

async function patchMealRow(
  mealId: string,
  eatenAt: string,
  description: string | null
): Promise<void> {
  const res = await fetch(`${SB_URL}/rest/v1/${MEALS_TABLE}?id=eq.${encodeURIComponent(mealId)}`, {
    method: 'PATCH',
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ eaten_at: eatenAt, description }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`meal patch failed (${res.status}): ${text}`);
  }
}

async function insertMealPhotoRow(
  mealId: string,
  photoPath: string,
  position: number
): Promise<MealPhotoRow> {
  const res = await fetch(`${SB_URL}/rest/v1/${PHOTOS_TABLE}`, {
    method: 'POST',
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({ meal_id: mealId, photo_path: photoPath, position }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`meal_photo insert failed (${res.status}): ${text}`);
  }
  const rows = (await res.json()) as MealPhotoRow[];
  return rows[0];
}

async function deleteMealPhotoRow(photoId: string): Promise<void> {
  const res = await fetch(
    `${SB_URL}/rest/v1/${PHOTOS_TABLE}?id=eq.${encodeURIComponent(photoId)}`,
    {
      method: 'DELETE',
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`meal_photo delete failed (${res.status}): ${text}`);
  }
}

async function deleteMealRow(mealId: string): Promise<void> {
  // ON DELETE CASCADE removes meal_photos rows too.
  const res = await fetch(`${SB_URL}/rest/v1/${MEALS_TABLE}?id=eq.${encodeURIComponent(mealId)}`, {
    method: 'DELETE',
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`meal delete failed (${res.status}): ${text}`);
  }
}

async function insertWeightRow(
  measuredAt: string,
  weightKg: number,
  notes: string | null
): Promise<WeightRow> {
  const res = await fetch(`${SB_URL}/rest/v1/${WEIGHT_TABLE}`, {
    method: 'POST',
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({ measured_at: measuredAt, weight_kg: weightKg, notes }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`weight insert failed (${res.status}): ${text}`);
  }
  const rows = (await res.json()) as WeightRow[];
  return rows[0];
}

async function patchWeightRow(
  weightId: string,
  measuredAt: string,
  weightKg: number,
  notes: string | null
): Promise<void> {
  const res = await fetch(
    `${SB_URL}/rest/v1/${WEIGHT_TABLE}?id=eq.${encodeURIComponent(weightId)}`,
    {
      method: 'PATCH',
      headers: {
        apikey: SB_KEY,
        Authorization: `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ measured_at: measuredAt, weight_kg: weightKg, notes }),
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`weight patch failed (${res.status}): ${text}`);
  }
}

async function deleteWeightRow(weightId: string): Promise<void> {
  const res = await fetch(
    `${SB_URL}/rest/v1/${WEIGHT_TABLE}?id=eq.${encodeURIComponent(weightId)}`,
    {
      method: 'DELETE',
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`weight delete failed (${res.status}): ${text}`);
  }
}

async function fetchMeals(): Promise<Meal[]> {
  const since = new Date();
  since.setDate(since.getDate() - HISTORY_DAYS);
  since.setHours(0, 0, 0, 0);

  const mealsUrl =
    `${SB_URL}/rest/v1/${MEALS_TABLE}` +
    `?select=id,eaten_at,description` +
    `&eaten_at=gte.${encodeURIComponent(since.toISOString())}` +
    `&order=eaten_at.desc`;
  const mealsRes = await fetch(mealsUrl, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  if (!mealsRes.ok) {
    const text = await mealsRes.text();
    throw new Error(`meals fetch failed (${mealsRes.status}): ${text}`);
  }
  const mealRows = (await mealsRes.json()) as MealRow[];
  if (mealRows.length === 0) return [];

  const ids = mealRows.map((r) => r.id);
  const inFilter = `(${ids.map((id) => `"${id}"`).join(',')})`;
  const photosUrl =
    `${SB_URL}/rest/v1/${PHOTOS_TABLE}` +
    `?select=id,meal_id,photo_path,position` +
    `&meal_id=in.${encodeURIComponent(inFilter)}` +
    `&order=position.asc`;
  const photosRes = await fetch(photosUrl, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  if (!photosRes.ok) {
    const text = await photosRes.text();
    throw new Error(`meal_photos fetch failed (${photosRes.status}): ${text}`);
  }
  const photoRows = (await photosRes.json()) as MealPhotoRow[];
  const photosByMeal = new Map<string, MealPhoto[]>();
  for (const p of photoRows) {
    const list = photosByMeal.get(p.meal_id) ?? [];
    list.push({
      id: p.id,
      photo_path: p.photo_path,
      photo_url: publicPhotoUrl(p.photo_path),
      position: p.position,
    });
    photosByMeal.set(p.meal_id, list);
  }

  return mealRows.map((m) => ({
    id: m.id,
    eaten_at: m.eaten_at,
    description: m.description,
    photos: (photosByMeal.get(m.id) ?? []).sort((a, b) => a.position - b.position),
    pending: false,
  }));
}

async function fetchWeights(): Promise<WeightEntry[]> {
  // Pull more than the preview count so the expanded history view is also populated.
  const url =
    `${SB_URL}/rest/v1/${WEIGHT_TABLE}` +
    `?select=id,measured_at,weight_kg,notes` +
    `&order=measured_at.desc&limit=200`;
  const res = await fetch(url, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`weights fetch failed (${res.status}): ${text}`);
  }
  const rows = (await res.json()) as WeightRow[];
  return rows.map((r) => ({
    id: r.id,
    measured_at: r.measured_at,
    weight_kg: typeof r.weight_kg === 'string' ? parseFloat(r.weight_kg) : r.weight_kg,
    notes: r.notes,
    pending: false,
  }));
}

// ─── Toast ──────────────────────────────────────────────────────────────────

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function toast(msg: string, ms = 1800): void {
  let t = $('.toast') as HTMLElement | null;
  if (!t) {
    t = el('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('visible');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t?.classList.remove('visible');
  }, ms);
}

// ─── Save flow (meals) ──────────────────────────────────────────────────────

// Save a new meal in one shot. Throws if any step fails — caller queues.
async function saveNewMealOnline(
  eatenAt: string,
  description: string | null,
  draftPhotos: DraftPhoto[]
): Promise<Meal> {
  const mealRow = await insertMealRow(eatenAt, description);
  const photos: MealPhoto[] = [];
  for (let i = 0; i < draftPhotos.length; i++) {
    const dp = draftPhotos[i];
    await uploadPhoto(dp.file, dp.photo_path);
    const photoRow = await insertMealPhotoRow(mealRow.id, dp.photo_path, i);
    photos.push({
      id: photoRow.id,
      photo_path: photoRow.photo_path,
      photo_url: publicPhotoUrl(photoRow.photo_path),
      position: photoRow.position,
    });
  }
  return {
    id: mealRow.id,
    eaten_at: mealRow.eaten_at,
    description: mealRow.description,
    photos,
    pending: false,
  };
}

// Update existing meal: patch fields, delete removed photos, upload+insert new
// ones (appended to end, position = existing.length + i).
async function saveEditedMealOnline(
  mealId: string,
  eatenAt: string,
  description: string | null,
  keptPhotos: MealPhoto[],
  removedPhotos: MealPhoto[],
  draftPhotos: DraftPhoto[]
): Promise<Meal> {
  await patchMealRow(mealId, eatenAt, description);
  for (const p of removedPhotos) {
    await deleteMealPhotoRow(p.id);
    void deleteStorageObject(p.photo_path);
  }
  const newPhotos: MealPhoto[] = [];
  const basePos = keptPhotos.length;
  for (let i = 0; i < draftPhotos.length; i++) {
    const dp = draftPhotos[i];
    await uploadPhoto(dp.file, dp.photo_path);
    const photoRow = await insertMealPhotoRow(mealId, dp.photo_path, basePos + i);
    newPhotos.push({
      id: photoRow.id,
      photo_path: photoRow.photo_path,
      photo_url: publicPhotoUrl(photoRow.photo_path),
      position: photoRow.position,
    });
  }
  return {
    id: mealId,
    eaten_at: eatenAt,
    description,
    photos: [...keptPhotos, ...newPhotos].sort((a, b) => a.position - b.position),
    pending: false,
  };
}

// Read DraftPhoto File → Blob (for IDB persistence).
async function fileToBlob(file: File): Promise<Blob> {
  // File already IS a Blob, but slicing detaches it from the input element
  // and ensures it survives IDB structured-clone reliably.
  const buf = await file.arrayBuffer();
  return new Blob([buf], { type: file.type || 'image/jpeg' });
}

// ─── Drain offline queue ────────────────────────────────────────────────────

let draining = false;
async function drainQueue(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    // Meals first.
    const pendingMeals = await readPendingMeals();
    for (const item of pendingMeals) {
      try {
        const mealRow = await insertMealRow(item.eaten_at, item.description);
        const photos: MealPhoto[] = [];
        for (const p of item.photos) {
          await uploadPhoto(p.blob, p.photo_path);
          const photoRow = await insertMealPhotoRow(mealRow.id, p.photo_path, p.position);
          photos.push({
            id: photoRow.id,
            photo_path: photoRow.photo_path,
            photo_url: publicPhotoUrl(photoRow.photo_path),
            position: photoRow.position,
          });
        }
        await removePendingMeal(item.localId);
        meals = meals.filter((m) => m.id !== item.localId);
        meals.unshift({
          id: mealRow.id,
          eaten_at: mealRow.eaten_at,
          description: mealRow.description,
          photos,
          pending: false,
        });
      } catch (err) {
        console.warn('[food-log] meal queue drain failed (will retry):', err);
        break;
      }
    }
    sortMeals();

    // Then weights.
    const pendingWeights = await readPendingWeights();
    for (const item of pendingWeights) {
      try {
        const row = await insertWeightRow(item.measured_at, item.weight_kg, item.notes);
        await removePendingWeight(item.localId);
        weights = weights.filter((w) => w.id !== item.localId);
        weights.unshift({
          id: row.id,
          measured_at: row.measured_at,
          weight_kg: typeof row.weight_kg === 'string' ? parseFloat(row.weight_kg) : row.weight_kg,
          notes: row.notes,
          pending: false,
        });
      } catch (err) {
        console.warn('[food-log] weight queue drain failed (will retry):', err);
        break;
      }
    }
    sortWeights();
    render();
  } finally {
    draining = false;
    updateQueueBanner();
  }
}

async function updateQueueBanner(): Promise<void> {
  const banner = $('.queue-banner');
  if (!banner) return;
  const mealCount = (await readPendingMeals().catch(() => [])).length;
  const weightCount = (await readPendingWeights().catch(() => [])).length;
  const total = mealCount + weightCount;
  if (total > 0) {
    const parts: string[] = [];
    if (mealCount > 0) parts.push(`${mealCount} meal${mealCount === 1 ? '' : 's'}`);
    if (weightCount > 0) parts.push(`${weightCount} weight${weightCount === 1 ? '' : 's'}`);
    banner.textContent = `${parts.join(' + ')} queued — will upload when online`;
    banner.classList.add('visible');
  } else {
    banner.classList.remove('visible');
  }
}

// ─── Meal-entry sheet ───────────────────────────────────────────────────────

function openSheetForNew(): void {
  sheet = {
    mealId: null,
    chip: 'now',
    eatenAtLocal: isoToDatetimeLocal(new Date().toISOString()),
    description: '',
    existingPhotos: [],
    removedExistingIds: new Set(),
    draftPhotos: [],
  };
  render();
}

function openSheetForEdit(m: Meal): void {
  const chip = chipForIso(m.eaten_at);
  sheet = {
    mealId: m.id,
    chip,
    eatenAtLocal: isoToDatetimeLocal(m.eaten_at),
    description: m.description ?? '',
    existingPhotos: [...m.photos],
    removedExistingIds: new Set(),
    draftPhotos: [],
  };
  // Edit replaces lightbox.
  lightboxMeal = null;
  render();
}

function closeSheet(force = false): void {
  if (!sheet) return;
  const hasContent =
    sheet.description.trim().length > 0 ||
    sheet.draftPhotos.length > 0 ||
    sheet.removedExistingIds.size > 0;
  if (!force && hasContent) {
    if (!window.confirm('Discard this meal?')) return;
  }
  for (const dp of sheet.draftPhotos) URL.revokeObjectURL(dp.blobUrl);
  sheet = null;
  render();
}

function sheetIsSaveable(s: SheetState): boolean {
  const hasText = s.description.trim().length > 0;
  const keptCount = s.existingPhotos.length - s.removedExistingIds.size;
  const hasPhotos = keptCount + s.draftPhotos.length > 0;
  return hasText || hasPhotos;
}

// Resolve the sheet's chip + eatenAtLocal into the final ISO timestamp at save time.
function resolveEatenAt(s: SheetState): string {
  if (s.chip === 'custom') return datetimeLocalToIso(s.eatenAtLocal);
  return isoForChip(s.chip);
}

async function commitSheet(): Promise<void> {
  if (!sheet) return;
  if (!sheetIsSaveable(sheet)) {
    toast('add a photo or description first');
    return;
  }
  const s = sheet;
  const eatenAt = resolveEatenAt(s);
  const description = s.description.trim() === '' ? null : s.description.trim();

  if (s.mealId === null) {
    // NEW meal.
    const localId = uuid();
    const draftCopy = [...s.draftPhotos];
    const optimistic: Meal = {
      id: localId,
      eaten_at: eatenAt,
      description,
      photos: draftCopy.map((dp, i) => ({
        id: `local-${i}-${localId}`,
        photo_path: dp.photo_path,
        photo_url: dp.blobUrl,
        position: i,
      })),
      pending: true,
    };
    meals.unshift(optimistic);
    sortMeals();
    sheet = null;
    render();
    toast('saving…');

    try {
      const saved = await saveNewMealOnline(eatenAt, description, draftCopy);
      meals = meals.filter((m) => m.id !== localId);
      meals.unshift(saved);
      for (const dp of draftCopy) URL.revokeObjectURL(dp.blobUrl);
      sortMeals();
      render();
      toast('saved ✓');
    } catch (err) {
      console.warn('[food-log] meal save failed, queueing:', err);
      const pendingPhotos: PendingPhotoBlob[] = [];
      for (let i = 0; i < draftCopy.length; i++) {
        const dp = draftCopy[i];
        pendingPhotos.push({
          photo_path: dp.photo_path,
          blob: await fileToBlob(dp.file),
          position: i,
        });
      }
      await queuePendingMeal({
        localId,
        eaten_at: eatenAt,
        description,
        photos: pendingPhotos,
      });
      toast('saved offline — will upload later', 2500);
    } finally {
      updateQueueBanner();
    }
  } else {
    // EDIT existing meal.
    const mealId = s.mealId;
    const keptPhotos = s.existingPhotos.filter((p) => !s.removedExistingIds.has(p.id));
    const removedPhotos = s.existingPhotos.filter((p) => s.removedExistingIds.has(p.id));
    const draftCopy = [...s.draftPhotos];
    sheet = null;
    render();
    toast('saving…');
    try {
      const saved = await saveEditedMealOnline(
        mealId,
        eatenAt,
        description,
        keptPhotos,
        removedPhotos,
        draftCopy
      );
      meals = meals.map((m) => (m.id === mealId ? saved : m));
      for (const dp of draftCopy) URL.revokeObjectURL(dp.blobUrl);
      sortMeals();
      render();
      toast('updated ✓');
    } catch (err) {
      console.error('[food-log] meal edit failed:', err);
      toast('update failed — try again');
    }
  }
}

// ─── Weight sheet ───────────────────────────────────────────────────────────

function lastKnownWeightKg(): number | null {
  if (weights.length === 0) return null;
  return weights[0].weight_kg;
}

function openWeightSheetForNew(): void {
  const last = lastKnownWeightKg();
  weightSheet = {
    weightId: null,
    chip: 'now',
    measuredAtLocal: isoToDatetimeLocal(new Date().toISOString()),
    weightKg: last !== null ? last.toFixed(1) : '',
    notes: '',
  };
  render();
}

function openWeightSheetForEdit(w: WeightEntry): void {
  weightSheet = {
    weightId: w.id,
    chip: chipForIso(w.measured_at),
    measuredAtLocal: isoToDatetimeLocal(w.measured_at),
    weightKg: w.weight_kg.toString(),
    notes: w.notes ?? '',
  };
  weightLightbox = null;
  render();
}

function closeWeightSheet(force = false): void {
  if (!weightSheet) return;
  const s = weightSheet;
  const hasNotes = s.notes.trim().length > 0;
  // If she pre-filled with last weight and didn't add notes, treat as
  // not-meaningful to dismiss without confirm — only confirm when there's a
  // notes change or a hand-typed weight that's genuinely new.
  if (!force && hasNotes) {
    if (!window.confirm('Discard this weight?')) return;
  }
  weightSheet = null;
  render();
}

function parseWeightKg(raw: string): number | null {
  const trimmed = raw.trim().replace(',', '.');
  if (trimmed === '') return null;
  const n = parseFloat(trimmed);
  if (!isFinite(n) || isNaN(n)) return null;
  // Reasonable bounds — avoid stray typos like "646" (forgot the dot).
  if (n <= 0 || n > 500) return null;
  return n;
}

function weightSheetIsSaveable(s: WeightSheetState): boolean {
  return parseWeightKg(s.weightKg) !== null;
}

function resolveMeasuredAt(s: WeightSheetState): string {
  if (s.chip === 'custom') return datetimeLocalToIso(s.measuredAtLocal);
  return isoForChip(s.chip);
}

async function commitWeightSheet(): Promise<void> {
  if (!weightSheet) return;
  if (!weightSheetIsSaveable(weightSheet)) {
    toast('enter a weight in kg first');
    return;
  }
  const s = weightSheet;
  const measuredAt = resolveMeasuredAt(s);
  const weightKg = parseWeightKg(s.weightKg);
  if (weightKg === null) return;
  const notes = s.notes.trim() === '' ? null : s.notes.trim();

  if (s.weightId === null) {
    const localId = uuid();
    const optimistic: WeightEntry = {
      id: localId,
      measured_at: measuredAt,
      weight_kg: weightKg,
      notes,
      pending: true,
    };
    weights.unshift(optimistic);
    sortWeights();
    weightSheet = null;
    render();
    toast('saving…');
    try {
      const row = await insertWeightRow(measuredAt, weightKg, notes);
      weights = weights.filter((w) => w.id !== localId);
      weights.unshift({
        id: row.id,
        measured_at: row.measured_at,
        weight_kg: typeof row.weight_kg === 'string' ? parseFloat(row.weight_kg) : row.weight_kg,
        notes: row.notes,
        pending: false,
      });
      sortWeights();
      render();
      toast('saved ✓');
    } catch (err) {
      console.warn('[food-log] weight save failed, queueing:', err);
      await queuePendingWeight({
        localId,
        measured_at: measuredAt,
        weight_kg: weightKg,
        notes,
      });
      toast('saved offline — will upload later', 2500);
    } finally {
      updateQueueBanner();
    }
  } else {
    // EDIT.
    const id = s.weightId;
    weightSheet = null;
    render();
    toast('saving…');
    try {
      await patchWeightRow(id, measuredAt, weightKg, notes);
      weights = weights.map((w) =>
        w.id === id ? { ...w, measured_at: measuredAt, weight_kg: weightKg, notes } : w
      );
      sortWeights();
      render();
      toast('updated ✓');
    } catch (err) {
      console.error('[food-log] weight edit failed:', err);
      toast('update failed — try again');
    }
  }
}

// ─── Photo picker (inside sheet) ────────────────────────────────────────────

function addDraftPhoto(file: File): void {
  if (!sheet) return;
  const path = buildPhotoPath(new Date());
  sheet.draftPhotos.push({
    file,
    photo_path: path,
    blobUrl: URL.createObjectURL(file),
  });
  render();
}

function removeDraftPhoto(index: number): void {
  if (!sheet) return;
  const dp = sheet.draftPhotos[index];
  if (dp) URL.revokeObjectURL(dp.blobUrl);
  sheet.draftPhotos.splice(index, 1);
  render();
}

function moveDraftPhoto(index: number, direction: -1 | 1): void {
  if (!sheet) return;
  const j = index + direction;
  if (j < 0 || j >= sheet.draftPhotos.length) return;
  const arr = sheet.draftPhotos;
  [arr[index], arr[j]] = [arr[j], arr[index]];
  render();
}

function removeExistingPhoto(photoId: string): void {
  if (!sheet) return;
  sheet.removedExistingIds.add(photoId);
  render();
}

function restoreExistingPhoto(photoId: string): void {
  if (!sheet) return;
  sheet.removedExistingIds.delete(photoId);
  render();
}

// ─── Sort ───────────────────────────────────────────────────────────────────

function sortMeals(): void {
  meals.sort((a, b) => new Date(b.eaten_at).getTime() - new Date(a.eaten_at).getTime());
}

function sortWeights(): void {
  weights.sort((a, b) => new Date(b.measured_at).getTime() - new Date(a.measured_at).getTime());
}

// ─── Render ─────────────────────────────────────────────────────────────────

function groupByDay(items: Meal[]): Map<number, Meal[]> {
  const map = new Map<number, Meal[]>();
  for (const m of items) {
    const key = startOfLocalDay(m.eaten_at);
    const arr = map.get(key) ?? [];
    arr.push(m);
    map.set(key, arr);
  }
  return map;
}

function renderMealCard(m: Meal): HTMLElement {
  const card = el('button', {
    class: 'meal-card',
    type: 'button',
    'data-meal-id': m.id,
    'aria-label': `Meal at ${formatTime(m.eaten_at)}`,
  });

  const header = el('div', { class: 'meal-card-header' });
  header.appendChild(el('span', { class: 'meal-card-time' }, [formatTime(m.eaten_at)]));
  if (m.pending) {
    header.appendChild(el('span', { class: 'meal-card-pending' }, ['queued']));
  }
  card.appendChild(header);

  if (m.photos.length > 0) {
    const strip = el('div', { class: 'meal-card-photos' });
    for (const p of m.photos) {
      const thumb = el('div', { class: 'meal-card-photo' });
      const img = el('img', {
        src: p.photo_url,
        alt: '',
        loading: 'lazy',
      }) as HTMLImageElement;
      thumb.appendChild(img);
      strip.appendChild(thumb);
    }
    card.appendChild(strip);
  }

  if (m.description && m.description.trim() !== '') {
    card.appendChild(el('div', { class: 'meal-card-desc' }, [previewDescription(m.description)]));
  } else if (m.photos.length === 0) {
    card.appendChild(el('div', { class: 'meal-card-desc meal-card-desc-empty' }, ['(empty)']));
  }

  card.addEventListener('click', () => openLightbox(m));
  return card;
}

function renderWeightRow(w: WeightEntry): HTMLElement {
  const row = el('button', {
    class: 'weight-row',
    type: 'button',
    'data-weight-id': w.id,
    'aria-label': `Weight ${w.weight_kg.toFixed(1)} kg on ${shortDate(w.measured_at)}`,
  });
  row.appendChild(el('span', { class: 'weight-row-kg' }, [`${w.weight_kg.toFixed(1)} kg`]));
  const meta = el('span', { class: 'weight-row-meta' });
  meta.appendChild(
    document.createTextNode(`${dayLabel(w.measured_at)} · ${formatTime(w.measured_at)}`)
  );
  if (w.pending) {
    meta.appendChild(el('span', { class: 'weight-row-pending' }, ['queued']));
  }
  row.appendChild(meta);
  if (w.notes && w.notes.trim() !== '') {
    row.appendChild(el('span', { class: 'weight-row-notes' }, [previewDescription(w.notes)]));
  }
  row.addEventListener('click', () => openWeightLightbox(w));
  return row;
}

// Tiny inline sparkline of weight trend across the visible entries (most recent
// → oldest from left → right reversed so latest sits at the right tip).
function renderSparkline(items: WeightEntry[]): HTMLElement | null {
  if (items.length < 2) return null;
  const ordered = [...items].reverse(); // oldest → newest
  const ks = ordered.map((w) => w.weight_kg);
  const min = Math.min(...ks);
  const max = Math.max(...ks);
  const range = max - min || 1; // avoid /0
  const w = 200;
  const h = 36;
  const stepX = w / (ordered.length - 1);
  const points = ordered
    .map((entry, i) => {
      const x = i * stepX;
      const y = h - ((entry.weight_kg - min) / range) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  // Using string-attrs only (matches our el() type) — wrap raw SVG in a span.
  const wrap = el('span', { class: 'weight-spark', 'aria-hidden': 'true' });
  wrap.innerHTML = `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none"><polyline fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" points="${points}" /></svg>`;
  return wrap;
}

function renderWeightSection(): HTMLElement {
  const section = el('section', { class: 'card weight-section' });
  const header = el('div', { class: 'card-header' });
  header.appendChild(el('h2', { class: 'card-title' }, ['Weight']));
  if (weights.length > 0) {
    header.appendChild(
      el('span', { class: 'card-meta' }, [
        `${weights.length} ${weights.length === 1 ? 'entry' : 'entries'}`,
      ])
    );
  }
  section.appendChild(header);

  if (weights.length === 0) {
    section.appendChild(
      el('div', { class: 'today-empty' }, [
        'No weight entries yet. Tap ⚖ Weight up top to log one.',
      ])
    );
    return section;
  }

  // Sparkline of the most-recent N when collapsed; full set when expanded.
  const visible = weightHistoryOpen ? weights : weights.slice(0, WEIGHT_PREVIEW_COUNT);
  const spark = renderSparkline(visible);
  if (spark) section.appendChild(spark);

  const list = el('div', { class: 'weight-list' });
  for (const w of visible) list.appendChild(renderWeightRow(w));
  section.appendChild(list);

  if (weights.length > WEIGHT_PREVIEW_COUNT) {
    const toggle = el('button', { class: 'weight-toggle', type: 'button' }, [
      weightHistoryOpen ? 'Show recent' : `Show all ${weights.length}`,
    ]);
    toggle.addEventListener('click', () => {
      weightHistoryOpen = !weightHistoryOpen;
      render();
    });
    section.appendChild(toggle);
  }

  return section;
}

function render(): void {
  const root = $('#app');
  if (!root) return;
  root.innerHTML = '';

  const today = startOfLocalDay(new Date().toISOString());
  const grouped = groupByDay(meals);
  const todayItems = grouped.get(today) ?? [];
  const otherDays = [...grouped.keys()].filter((k) => k !== today).sort((a, b) => b - a);

  const app = el('div', { class: 'app' });

  // Header
  const header = el('header', { class: 'app-header' });
  header.appendChild(el('h1', {}, ['Food Log']));
  header.appendChild(
    el('span', { class: 'header-sub' }, [
      new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    ])
  );
  app.appendChild(header);

  // Sibling quick-action pills (Meal + Weight). The big bottom Add button is
  // removed in v1.6 — these two siblings replace it. One screen, two parallel
  // capture surfaces.
  const quick = el('div', { class: 'quick-actions' });
  const addMealBtn = el(
    'button',
    {
      class: 'quick-action quick-action-primary',
      type: 'button',
      id: 'add-meal-btn',
      'aria-label': 'Add a meal',
    },
    [el('span', { class: 'quick-icon', 'aria-hidden': 'true' }, ['➕']), ' Meal']
  );
  addMealBtn.addEventListener('click', () => openSheetForNew());
  const addWeightBtn = el(
    'button',
    {
      class: 'quick-action quick-action-secondary',
      type: 'button',
      id: 'add-weight-btn',
      'aria-label': 'Log weight',
    },
    [el('span', { class: 'quick-icon', 'aria-hidden': 'true' }, ['⚖']), ' Weight']
  );
  addWeightBtn.addEventListener('click', () => openWeightSheetForNew());
  quick.appendChild(addMealBtn);
  quick.appendChild(addWeightBtn);
  app.appendChild(quick);

  // Queue banner
  app.appendChild(el('div', { class: 'queue-banner', role: 'status', 'aria-live': 'polite' }));

  // Today card
  const todayCard = el('section', { class: 'card' });
  const todayHeader = el('div', { class: 'card-header' });
  todayHeader.appendChild(el('h2', { class: 'card-title' }, ['Today']));
  todayHeader.appendChild(
    el('span', { class: 'card-meta' }, [
      `${todayItems.length} ${todayItems.length === 1 ? 'meal' : 'meals'}`,
    ])
  );
  todayCard.appendChild(todayHeader);

  if (todayItems.length === 0) {
    todayCard.appendChild(
      el('div', { class: 'today-empty' }, ['No meals yet today. Tap ➕ Meal up top to add one.'])
    );
  } else {
    const list = el('div', { class: 'meal-list' });
    for (const m of todayItems) list.appendChild(renderMealCard(m));
    todayCard.appendChild(list);
  }
  app.appendChild(todayCard);

  // History section
  if (otherDays.length > 0) {
    const hist = el('section', { class: 'history' });
    for (const dayKey of otherDays) {
      const items = grouped.get(dayKey) ?? [];
      const details = el('details', { class: 'history-day' }) as HTMLDetailsElement;
      const summary = el('summary', { class: 'history-day-summary' });
      summary.appendChild(
        el('span', { class: 'history-day-title' }, [dayLabel(new Date(dayKey).toISOString())])
      );
      summary.appendChild(
        el('span', { class: 'history-day-count' }, [
          `${items.length} ${items.length === 1 ? 'meal' : 'meals'}`,
        ])
      );
      details.appendChild(summary);
      const body = el('div', { class: 'history-day-body' });
      const list = el('div', { class: 'meal-list' });
      for (const m of items) list.appendChild(renderMealCard(m));
      body.appendChild(list);
      details.appendChild(body);
      hist.appendChild(details);
    }
    app.appendChild(hist);
  } else if (todayItems.length > 0) {
    app.appendChild(el('div', { class: 'history-empty' }, ['No earlier days yet — keep going.']));
  }

  // Weight section (below meals).
  app.appendChild(renderWeightSection());

  root.appendChild(app);

  if (lightboxMeal) {
    root.appendChild(buildLightbox(lightboxMeal));
  }
  if (weightLightbox) {
    root.appendChild(buildWeightLightbox(weightLightbox));
  }

  if (sheet) {
    root.appendChild(buildSheet(sheet));
  }
  if (weightSheet) {
    root.appendChild(buildWeightSheet(weightSheet));
  }

  void updateQueueBanner();
}

// ─── Fuzzy time chip row (shared by meal + weight sheets) ───────────────────

interface ChipRowApi {
  node: HTMLElement;
  setChip: (c: ChipId) => void;
}

function buildChipRow(
  initial: ChipId,
  onChange: (c: ChipId) => void,
  idPrefix: string
): ChipRowApi {
  const row = el('div', { class: 'chip-row', role: 'radiogroup', 'aria-label': 'When' });
  const buttons = new Map<ChipId, HTMLButtonElement>();
  let current: ChipId = initial;

  function refresh(): void {
    for (const [id, btn] of buttons) {
      if (id === current) {
        btn.classList.add('chip-selected');
        btn.setAttribute('aria-checked', 'true');
      } else {
        btn.classList.remove('chip-selected');
        btn.setAttribute('aria-checked', 'false');
      }
    }
  }

  for (const def of CHIP_DEFS) {
    const btn = el(
      'button',
      {
        type: 'button',
        class: 'chip',
        id: `${idPrefix}-chip-${def.id}`,
        'data-chip': def.id,
        role: 'radio',
        'aria-checked': 'false',
      },
      [def.label]
    ) as HTMLButtonElement;
    btn.addEventListener('click', () => {
      current = def.id;
      refresh();
      onChange(def.id);
    });
    buttons.set(def.id, btn);
    row.appendChild(btn);
  }
  refresh();
  return {
    node: row,
    setChip(c: ChipId) {
      current = c;
      refresh();
    },
  };
}

// ─── Meal-entry sheet UI ────────────────────────────────────────────────────

function buildSheet(s: SheetState): HTMLElement {
  const overlay = el('div', { class: 'sheet-overlay', role: 'dialog', 'aria-modal': 'true' });
  const panel = el('div', { class: 'sheet-panel' });

  // Top bar with title + close.
  const topBar = el('div', { class: 'sheet-topbar' });
  topBar.appendChild(
    el('h2', { class: 'sheet-title' }, [s.mealId === null ? 'New meal' : 'Edit meal'])
  );
  const closeBtn = el(
    'button',
    { class: 'sheet-close', type: 'button', id: 'sheet-close', 'aria-label': 'Close' },
    ['✕']
  );
  closeBtn.addEventListener('click', () => closeSheet());
  topBar.appendChild(closeBtn);
  panel.appendChild(topBar);

  const body = el('div', { class: 'sheet-body' });

  // Fuzzy time field — chip row + collapsible Custom expander.
  const timeWrap = el('div', { class: 'sheet-field' });
  const timeLabelRow = el('div', { class: 'sheet-label-row' });
  timeLabelRow.appendChild(el('span', { class: 'sheet-label' }, ['When']));
  // Current selected-chip label sits next to the title for at-a-glance feedback.
  const chipDisplay = el('span', { class: 'sheet-chip-display', id: 'sheet-chip-display' }, [
    chipLabel(s.chip),
  ]);
  timeLabelRow.appendChild(chipDisplay);
  timeWrap.appendChild(timeLabelRow);

  // The chip row.
  const customWrap = el('div', { class: 'sheet-custom-row', id: 'sheet-custom-row' });
  const [datePart, timePart] = (
    s.eatenAtLocal || isoToDatetimeLocal(new Date().toISOString())
  ).split('T');
  const dateInput = el('input', {
    type: 'date',
    class: 'sheet-date',
    id: 'sheet-date',
    value: datePart,
    'aria-label': 'Date eaten',
  }) as HTMLInputElement;
  const timeInput = el('input', {
    type: 'time',
    class: 'sheet-time',
    id: 'sheet-time',
    value: timePart,
    'aria-label': 'Time eaten',
  }) as HTMLInputElement;
  const recombine = (): void => {
    if (sheet && dateInput.value && timeInput.value) {
      sheet.eatenAtLocal = `${dateInput.value}T${timeInput.value}`;
    }
  };
  dateInput.addEventListener('input', recombine);
  timeInput.addEventListener('input', recombine);
  customWrap.appendChild(dateInput);
  customWrap.appendChild(timeInput);

  function reflectCustomVisibility(c: ChipId): void {
    if (c === 'custom') {
      customWrap.classList.add('visible');
    } else {
      customWrap.classList.remove('visible');
    }
  }

  const chipApi = buildChipRow(
    s.chip,
    (c) => {
      if (sheet) sheet.chip = c;
      chipDisplay.textContent = chipLabel(c);
      reflectCustomVisibility(c);
    },
    'meal'
  );
  timeWrap.appendChild(chipApi.node);
  timeWrap.appendChild(customWrap);
  reflectCustomVisibility(s.chip);
  body.appendChild(timeWrap);

  // Description textarea.
  const descWrap = el('label', { class: 'sheet-field' });
  descWrap.appendChild(el('span', { class: 'sheet-label' }, ['What did you eat?']));
  const desc = el('textarea', {
    class: 'sheet-desc',
    id: 'sheet-desc',
    rows: '3',
    placeholder: 'Type or tap the mic on your keyboard…',
  }) as HTMLTextAreaElement;
  desc.value = s.description;
  const autoGrow = (): void => {
    desc.style.height = 'auto';
    desc.style.height = desc.scrollHeight + 'px';
  };
  desc.addEventListener('input', () => {
    if (sheet) sheet.description = desc.value;
    autoGrow();
    updateSaveButton();
  });
  descWrap.appendChild(desc);
  body.appendChild(descWrap);
  setTimeout(autoGrow, 0);

  // Photos area.
  const photosWrap = el('div', { class: 'sheet-field' });
  photosWrap.appendChild(el('span', { class: 'sheet-label' }, ['Photos']));

  const thumbs = el('div', { class: 'sheet-thumbs' });

  s.existingPhotos.forEach((p) => {
    const removed = s.removedExistingIds.has(p.id);
    const thumb = el('div', {
      class: removed ? 'sheet-thumb sheet-thumb-removed' : 'sheet-thumb',
    });
    const img = el('img', { src: p.photo_url, alt: '' }) as HTMLImageElement;
    thumb.appendChild(img);
    if (removed) {
      const restore = el(
        'button',
        { type: 'button', class: 'sheet-thumb-restore', 'aria-label': 'Restore' },
        ['↺']
      );
      restore.addEventListener('click', () => restoreExistingPhoto(p.id));
      thumb.appendChild(restore);
    } else {
      const x = el(
        'button',
        { type: 'button', class: 'sheet-thumb-remove', 'aria-label': 'Remove photo' },
        ['✕']
      );
      x.addEventListener('click', () => removeExistingPhoto(p.id));
      thumb.appendChild(x);
    }
    thumbs.appendChild(thumb);
  });

  s.draftPhotos.forEach((dp, i) => {
    const thumb = el('div', { class: 'sheet-thumb sheet-thumb-draft' });
    const img = el('img', { src: dp.blobUrl, alt: '' }) as HTMLImageElement;
    thumb.appendChild(img);
    const x = el(
      'button',
      { type: 'button', class: 'sheet-thumb-remove', 'aria-label': 'Remove photo' },
      ['✕']
    );
    x.addEventListener('click', () => removeDraftPhoto(i));
    thumb.appendChild(x);
    if (s.draftPhotos.length > 1) {
      const reorder = el('div', { class: 'sheet-thumb-reorder' });
      const up = el(
        'button',
        {
          type: 'button',
          class: 'sheet-thumb-arrow',
          'aria-label': 'Move up',
          ...(i === 0 ? { disabled: 'true' } : {}),
        },
        ['↑']
      );
      if (i > 0) up.addEventListener('click', () => moveDraftPhoto(i, -1));
      const down = el(
        'button',
        {
          type: 'button',
          class: 'sheet-thumb-arrow',
          'aria-label': 'Move down',
          ...(i === s.draftPhotos.length - 1 ? { disabled: 'true' } : {}),
        },
        ['↓']
      );
      if (i < s.draftPhotos.length - 1) down.addEventListener('click', () => moveDraftPhoto(i, 1));
      reorder.appendChild(up);
      reorder.appendChild(down);
      thumb.appendChild(reorder);
    }
    thumbs.appendChild(thumb);
  });

  photosWrap.appendChild(thumbs);

  const addPhotoBtn = el(
    'button',
    {
      type: 'button',
      class: 'sheet-add-photo',
      id: 'sheet-add-photo',
      'aria-label': 'Add photo',
    },
    [el('span', { 'aria-hidden': 'true' }, ['📷']), ' Add photo']
  );
  const photoInput = el('input', {
    type: 'file',
    accept: 'image/*',
    capture: 'environment',
    class: 'camera-input-hidden',
    id: 'sheet-photo-input',
  }) as HTMLInputElement;
  addPhotoBtn.addEventListener('click', () => photoInput.click());
  photoInput.addEventListener('change', () => {
    const file = photoInput.files && photoInput.files[0];
    if (file) addDraftPhoto(file);
    photoInput.value = '';
  });
  photosWrap.appendChild(addPhotoBtn);
  photosWrap.appendChild(photoInput);
  body.appendChild(photosWrap);

  panel.appendChild(body);

  const footer = el('div', { class: 'sheet-footer' });
  const cancelBtn = el('button', { type: 'button', class: 'sheet-cancel' }, ['Cancel']);
  cancelBtn.addEventListener('click', () => closeSheet());
  footer.appendChild(cancelBtn);

  const saveAttrs: Record<string, string> = {
    type: 'button',
    class: 'sheet-save',
    id: 'sheet-save',
  };
  if (!sheetIsSaveable(s)) saveAttrs.disabled = 'true';
  const saveBtn = el('button', saveAttrs, ['Save']);
  saveBtn.addEventListener('click', () => {
    void commitSheet();
  });
  footer.appendChild(saveBtn);
  panel.appendChild(footer);

  function updateSaveButton(): void {
    if (!sheet) return;
    if (sheetIsSaveable(sheet)) {
      saveBtn.removeAttribute('disabled');
    } else {
      saveBtn.setAttribute('disabled', 'true');
    }
  }

  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) closeSheet();
  });

  // Silence unused-locals warning on chipApi (we hold the reference for the
  // setChip handle even though we don't currently call it externally).
  void chipApi.setChip;

  overlay.appendChild(panel);
  return overlay;
}

// ─── Weight-entry sheet UI ──────────────────────────────────────────────────

function buildWeightSheet(s: WeightSheetState): HTMLElement {
  const overlay = el('div', {
    class: 'sheet-overlay weight-sheet-overlay',
    role: 'dialog',
    'aria-modal': 'true',
  });
  const panel = el('div', { class: 'sheet-panel' });

  const topBar = el('div', { class: 'sheet-topbar' });
  topBar.appendChild(
    el('h2', { class: 'sheet-title' }, [s.weightId === null ? 'Log weight' : 'Edit weight'])
  );
  const closeBtn = el(
    'button',
    { class: 'sheet-close', type: 'button', id: 'weight-sheet-close', 'aria-label': 'Close' },
    ['✕']
  );
  closeBtn.addEventListener('click', () => closeWeightSheet());
  topBar.appendChild(closeBtn);
  panel.appendChild(topBar);

  const body = el('div', { class: 'sheet-body' });

  // Fuzzy time field — same chip row as meals.
  const timeWrap = el('div', { class: 'sheet-field' });
  const timeLabelRow = el('div', { class: 'sheet-label-row' });
  timeLabelRow.appendChild(el('span', { class: 'sheet-label' }, ['When']));
  const chipDisplay = el('span', { class: 'sheet-chip-display', id: 'weight-chip-display' }, [
    chipLabel(s.chip),
  ]);
  timeLabelRow.appendChild(chipDisplay);
  timeWrap.appendChild(timeLabelRow);

  const customWrap = el('div', {
    class: 'sheet-custom-row',
    id: 'weight-custom-row',
  });
  const [datePart, timePart] = (
    s.measuredAtLocal || isoToDatetimeLocal(new Date().toISOString())
  ).split('T');
  const dateInput = el('input', {
    type: 'date',
    class: 'sheet-date',
    id: 'weight-sheet-date',
    value: datePart,
    'aria-label': 'Date measured',
  }) as HTMLInputElement;
  const timeInput = el('input', {
    type: 'time',
    class: 'sheet-time',
    id: 'weight-sheet-time',
    value: timePart,
    'aria-label': 'Time measured',
  }) as HTMLInputElement;
  const recombine = (): void => {
    if (weightSheet && dateInput.value && timeInput.value) {
      weightSheet.measuredAtLocal = `${dateInput.value}T${timeInput.value}`;
    }
  };
  dateInput.addEventListener('input', recombine);
  timeInput.addEventListener('input', recombine);
  customWrap.appendChild(dateInput);
  customWrap.appendChild(timeInput);

  function reflectCustomVisibility(c: ChipId): void {
    if (c === 'custom') {
      customWrap.classList.add('visible');
    } else {
      customWrap.classList.remove('visible');
    }
  }

  const chipApi = buildChipRow(
    s.chip,
    (c) => {
      if (weightSheet) weightSheet.chip = c;
      chipDisplay.textContent = chipLabel(c);
      reflectCustomVisibility(c);
    },
    'weight'
  );
  timeWrap.appendChild(chipApi.node);
  timeWrap.appendChild(customWrap);
  reflectCustomVisibility(s.chip);
  body.appendChild(timeWrap);

  // Weight numeric input.
  const kgWrap = el('label', { class: 'sheet-field' });
  kgWrap.appendChild(el('span', { class: 'sheet-label' }, ['Weight (kg)']));
  const kgInput = el('input', {
    type: 'number',
    inputmode: 'decimal',
    step: '0.1',
    min: '0',
    max: '500',
    class: 'sheet-weight-input',
    id: 'sheet-weight-input',
    placeholder: 'e.g. 64.3',
    autocomplete: 'off',
  }) as HTMLInputElement;
  kgInput.value = s.weightKg;
  kgInput.addEventListener('input', () => {
    if (weightSheet) weightSheet.weightKg = kgInput.value;
    updateSaveButton();
  });
  kgWrap.appendChild(kgInput);
  body.appendChild(kgWrap);

  // Optional notes.
  const notesWrap = el('label', { class: 'sheet-field' });
  notesWrap.appendChild(el('span', { class: 'sheet-label' }, ['Notes (optional)']));
  const notes = el('textarea', {
    class: 'sheet-desc',
    id: 'sheet-weight-notes',
    rows: '2',
    placeholder: 'Anything to note (PMS, post-workout, etc.)',
  }) as HTMLTextAreaElement;
  notes.value = s.notes;
  const autoGrow = (): void => {
    notes.style.height = 'auto';
    notes.style.height = notes.scrollHeight + 'px';
  };
  notes.addEventListener('input', () => {
    if (weightSheet) weightSheet.notes = notes.value;
    autoGrow();
  });
  notesWrap.appendChild(notes);
  body.appendChild(notesWrap);
  setTimeout(autoGrow, 0);

  panel.appendChild(body);

  const footer = el('div', { class: 'sheet-footer' });
  const cancelBtn = el('button', { type: 'button', class: 'sheet-cancel' }, ['Cancel']);
  cancelBtn.addEventListener('click', () => closeWeightSheet());
  footer.appendChild(cancelBtn);

  const saveAttrs: Record<string, string> = {
    type: 'button',
    class: 'sheet-save',
    id: 'sheet-weight-save',
  };
  if (!weightSheetIsSaveable(s)) saveAttrs.disabled = 'true';
  const saveBtn = el('button', saveAttrs, ['Save']);
  saveBtn.addEventListener('click', () => {
    void commitWeightSheet();
  });
  footer.appendChild(saveBtn);
  panel.appendChild(footer);

  function updateSaveButton(): void {
    if (!weightSheet) return;
    if (weightSheetIsSaveable(weightSheet)) {
      saveBtn.removeAttribute('disabled');
    } else {
      saveBtn.setAttribute('disabled', 'true');
    }
  }

  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) closeWeightSheet();
  });

  void chipApi.setChip;

  overlay.appendChild(panel);
  return overlay;
}

// ─── Lightbox (meal detail view) ────────────────────────────────────────────

function openLightbox(m: Meal): void {
  lightboxMeal = m;
  render();
}

function closeLightbox(): void {
  lightboxMeal = null;
  render();
}

function buildLightbox(m: Meal): HTMLElement {
  const root = el('div', { class: 'lightbox', role: 'dialog', 'aria-modal': 'true' });
  const inner = el('div', { class: 'lightbox-inner' });

  if (m.photos.length > 0) {
    const gallery = el('div', { class: 'lightbox-gallery' });
    for (const p of m.photos) {
      const img = el('img', { src: p.photo_url, alt: '' }) as HTMLImageElement;
      gallery.appendChild(img);
    }
    inner.appendChild(gallery);
  }

  inner.appendChild(el('div', { class: 'lightbox-time' }, [formatTime(m.eaten_at)]));

  if (m.description && m.description.trim() !== '') {
    inner.appendChild(el('div', { class: 'lightbox-desc' }, [m.description]));
  }

  const actions = el('div', { class: 'lightbox-actions' });
  const closeBtn = el('button', { class: 'lightbox-close', type: 'button' }, ['Close']);
  closeBtn.addEventListener('click', closeLightbox);
  actions.appendChild(closeBtn);

  if (!m.pending) {
    const editBtn = el(
      'button',
      { class: 'lightbox-edit', type: 'button', 'aria-label': 'Edit meal' },
      ['Edit']
    );
    editBtn.addEventListener('click', () => openSheetForEdit(m));
    actions.appendChild(editBtn);

    const delBtn = el('button', {
      class: 'lightbox-delete',
      type: 'button',
      'aria-label': 'Hold to delete meal',
    });
    delBtn.appendChild(el('span', { class: 'hold-fill' }));
    delBtn.appendChild(el('span', { class: 'lightbox-delete-label' }, ['Hold to delete']));

    let holdTimer: ReturnType<typeof setTimeout> | null = null;
    const startHold = (): void => {
      delBtn.classList.add('holding');
      holdTimer = setTimeout(() => {
        void (async () => {
          try {
            for (const p of m.photos) void deleteStorageObject(p.photo_path);
            await deleteMealRow(m.id);
            meals = meals.filter((x) => x.id !== m.id);
            closeLightbox();
            toast('deleted');
          } catch (err) {
            console.error('[food-log] delete failed:', err);
            toast('delete failed');
            delBtn.classList.remove('holding');
          }
        })();
      }, 700);
    };
    const cancelHold = (): void => {
      delBtn.classList.remove('holding');
      if (holdTimer) {
        clearTimeout(holdTimer);
        holdTimer = null;
      }
    };
    delBtn.addEventListener('pointerdown', startHold);
    delBtn.addEventListener('pointerup', cancelHold);
    delBtn.addEventListener('pointerleave', cancelHold);
    delBtn.addEventListener('pointercancel', cancelHold);
    actions.appendChild(delBtn);
  }

  inner.appendChild(actions);
  root.appendChild(inner);

  root.addEventListener('click', (ev) => {
    if (ev.target === root) closeLightbox();
  });

  return root;
}

function openWeightLightbox(w: WeightEntry): void {
  weightLightbox = w;
  render();
}

function closeWeightLightbox(): void {
  weightLightbox = null;
  render();
}

function buildWeightLightbox(w: WeightEntry): HTMLElement {
  const root = el('div', {
    class: 'lightbox weight-lightbox',
    role: 'dialog',
    'aria-modal': 'true',
  });
  const inner = el('div', { class: 'lightbox-inner' });

  inner.appendChild(el('div', { class: 'lightbox-weight-kg' }, [`${w.weight_kg.toFixed(1)} kg`]));
  inner.appendChild(
    el('div', { class: 'lightbox-time' }, [
      `${dayLabel(w.measured_at)} · ${formatTime(w.measured_at)}`,
    ])
  );

  if (w.notes && w.notes.trim() !== '') {
    inner.appendChild(el('div', { class: 'lightbox-desc' }, [w.notes]));
  }

  const actions = el('div', { class: 'lightbox-actions' });
  const closeBtn = el('button', { class: 'lightbox-close', type: 'button' }, ['Close']);
  closeBtn.addEventListener('click', closeWeightLightbox);
  actions.appendChild(closeBtn);

  if (!w.pending) {
    const editBtn = el(
      'button',
      { class: 'lightbox-edit', type: 'button', 'aria-label': 'Edit weight' },
      ['Edit']
    );
    editBtn.addEventListener('click', () => openWeightSheetForEdit(w));
    actions.appendChild(editBtn);

    const delBtn = el('button', {
      class: 'lightbox-delete',
      type: 'button',
      'aria-label': 'Hold to delete weight',
    });
    delBtn.appendChild(el('span', { class: 'hold-fill' }));
    delBtn.appendChild(el('span', { class: 'lightbox-delete-label' }, ['Hold to delete']));

    let holdTimer: ReturnType<typeof setTimeout> | null = null;
    const startHold = (): void => {
      delBtn.classList.add('holding');
      holdTimer = setTimeout(() => {
        void (async () => {
          try {
            await deleteWeightRow(w.id);
            weights = weights.filter((x) => x.id !== w.id);
            closeWeightLightbox();
            toast('deleted');
          } catch (err) {
            console.error('[food-log] weight delete failed:', err);
            toast('delete failed');
            delBtn.classList.remove('holding');
          }
        })();
      }, 700);
    };
    const cancelHold = (): void => {
      delBtn.classList.remove('holding');
      if (holdTimer) {
        clearTimeout(holdTimer);
        holdTimer = null;
      }
    };
    delBtn.addEventListener('pointerdown', startHold);
    delBtn.addEventListener('pointerup', cancelHold);
    delBtn.addEventListener('pointerleave', cancelHold);
    delBtn.addEventListener('pointercancel', cancelHold);
    actions.appendChild(delBtn);
  }

  inner.appendChild(actions);
  root.appendChild(inner);

  root.addEventListener('click', (ev) => {
    if (ev.target === root) closeWeightLightbox();
  });

  return root;
}

// ─── Boot ──────────────────────────────────────────────────────────────────

async function boot(): Promise<void> {
  render(); // initial paint: empty state + quick-action buttons
  try {
    const [m, w] = await Promise.all([fetchMeals(), fetchWeights()]);
    meals = m;
    weights = w;
    sortMeals();
    sortWeights();
    render();
  } catch (err) {
    console.warn('[food-log] initial fetch failed (showing empty):', err);
  }
  void drainQueue();

  window.addEventListener('online', () => {
    void drainQueue();
  });
}

void boot();
