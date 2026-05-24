/**
 * food-log — v1.5.
 *
 * Scope (Allison's words, May 2026): "I wanted to be able to either take a
 * picture or describe what I ate 'cause like let's say I just ate and I didn't
 * take a picture so I wanna be able to describe it and also I wanna be able to
 * put in multiple pictures per meal and write or voice to text whatever."
 *
 * A meal = atom. A meal has 0+ photos AND/OR a written/voice-to-text
 * description. App enforces "at least one of the two" before save. Voice-to-text
 * is free from the OS keyboard mic — we just expose a <textarea>.
 *
 * Storage: Supabase Storage bucket `food-photos` (public, mirrors single-user
 * setup of sibling apps). Tables `meals` + `meal_photos` (1:N). Offline
 * captures queue the entire meal (description + photos) as one unit in
 * IndexedDB and drain on next online tick.
 *
 * v2-ready hooks:
 *   - photo path structured `{yyyy}/{mm}/{uuid}.jpg` so vision models can later
 *     fetch deterministically via Storage public URL
 *   - `meals.description` available for AI captioning / fusion w/ vision
 */

// ─── Config ─────────────────────────────────────────────────────────────────

const SB_URL = 'https://hpiyvnfhoqnnnotrmwaz.supabase.co';
const SB_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhwaXl2bmZob3Fubm5vdHJtd2F6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI0NzIwNDEsImV4cCI6MjA4ODA0ODA0MX0.AsGhYitkSnyVMwpJII05UseS_gICaXiCy7d8iHsr6Qw';

const BUCKET = 'food-photos';
const MEALS_TABLE = 'meals';
const PHOTOS_TABLE = 'meal_photos';
const HISTORY_DAYS = 30;
const IDB_NAME = 'food-log-queue';
const IDB_STORE = 'pending-meals'; // v1.5 store; v1 used 'pending'

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

// State the meal-entry sheet manages while it's open.
interface DraftPhoto {
  // The picked file is held in memory; the photo_path is pre-allocated so the
  // optimistic UI and the later upload share the same key.
  file: File;
  photo_path: string;
  blobUrl: string; // URL.createObjectURL preview
}

interface SheetState {
  mealId: string | null; // null = new meal; otherwise editing
  eatenAtLocal: string; // value of <input type=datetime-local>
  description: string;
  // For an edit, existing photos already on the server that the user hasn't
  // removed. Removed ones go to removedExistingIds.
  existingPhotos: MealPhoto[];
  removedExistingIds: Set<string>;
  draftPhotos: DraftPhoto[]; // newly picked, not yet uploaded
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
let lightboxMeal: Meal | null = null;
let sheet: SheetState | null = null;

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
    const req = indexedDB.open(IDB_NAME, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      // v1.5: pending-meals store (whole meal as atomic unit).
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE, { keyPath: 'localId' });
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
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function readPendingMeals(): Promise<PendingMeal[]> {
  const db = await openDb();
  const result = await new Promise<PendingMeal[]>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).getAll();
    req.onsuccess = () => resolve(req.result as PendingMeal[]);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return result;
}

async function removePendingMeal(localId: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(localId);
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

// ─── Save flow ──────────────────────────────────────────────────────────────

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
    const pending = await readPendingMeals();
    for (const item of pending) {
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
        // Replace optimistic-pending meal (id === localId) with the real one.
        meals = meals.filter((m) => m.id !== item.localId);
        meals.unshift({
          id: mealRow.id,
          eaten_at: mealRow.eaten_at,
          description: mealRow.description,
          photos,
          pending: false,
        });
      } catch (err) {
        console.warn('[food-log] queue drain item failed (will retry later):', err);
        break; // stop on first failure
      }
    }
    sortMeals();
    render();
  } finally {
    draining = false;
    updateQueueBanner();
  }
}

async function updateQueueBanner(): Promise<void> {
  const banner = $('.queue-banner');
  if (!banner) return;
  const count = (await readPendingMeals().catch(() => [])).length;
  if (count > 0) {
    banner.textContent = `${count} meal${count === 1 ? '' : 's'} queued — will upload when online`;
    banner.classList.add('visible');
  } else {
    banner.classList.remove('visible');
  }
}

// ─── Meal-entry sheet ───────────────────────────────────────────────────────

function openSheetForNew(): void {
  sheet = {
    mealId: null,
    eatenAtLocal: isoToDatetimeLocal(new Date().toISOString()),
    description: '',
    existingPhotos: [],
    removedExistingIds: new Set(),
    draftPhotos: [],
  };
  render();
}

function openSheetForEdit(m: Meal): void {
  sheet = {
    mealId: m.id,
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
  // Revoke object URLs to free memory.
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

async function commitSheet(): Promise<void> {
  if (!sheet) return;
  if (!sheetIsSaveable(sheet)) {
    toast('add a photo or description first');
    return;
  }
  const s = sheet;
  const eatenAt = datetimeLocalToIso(s.eatenAtLocal);
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
      // Free blob URLs now that we have real public URLs.
      for (const dp of draftCopy) URL.revokeObjectURL(dp.blobUrl);
      sortMeals();
      render();
      toast('saved ✓');
    } catch (err) {
      console.warn('[food-log] meal save failed, queueing:', err);
      // Convert draft files → blobs for IDB persistence.
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
    // EDIT existing meal. Online-only for v1.5 — if it fails, surface error.
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

  // Header row: time + (pending badge)
  const header = el('div', { class: 'meal-card-header' });
  header.appendChild(el('span', { class: 'meal-card-time' }, [formatTime(m.eaten_at)]));
  if (m.pending) {
    header.appendChild(el('span', { class: 'meal-card-pending' }, ['queued']));
  }
  card.appendChild(header);

  // Photo strip (only if there are photos)
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

  // Description preview
  if (m.description && m.description.trim() !== '') {
    card.appendChild(el('div', { class: 'meal-card-desc' }, [previewDescription(m.description)]));
  } else if (m.photos.length === 0) {
    // Should never happen (save is blocked), but defensive.
    card.appendChild(el('div', { class: 'meal-card-desc meal-card-desc-empty' }, ['(empty)']));
  }

  card.addEventListener('click', () => openLightbox(m));
  return card;
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
      el('div', { class: 'today-empty' }, ['No meals yet today. Tap the button below to add one.'])
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

  // Floating "Add a meal" button
  const fab = el('div', { class: 'camera-fab' });
  const fabBtn = el(
    'button',
    {
      class: 'camera-fab-btn',
      type: 'button',
      id: 'add-meal-btn',
      'aria-label': 'Add a meal',
    },
    [el('span', { class: 'camera-icon', 'aria-hidden': 'true' }, ['➕']), 'Add a meal']
  );
  fab.appendChild(fabBtn);
  fabBtn.addEventListener('click', () => openSheetForNew());
  app.appendChild(fab);

  root.appendChild(app);

  if (lightboxMeal) {
    root.appendChild(buildLightbox(lightboxMeal));
  }

  if (sheet) {
    root.appendChild(buildSheet(sheet));
  }

  void updateQueueBanner();
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

  // Time field.
  const timeWrap = el('label', { class: 'sheet-field' });
  timeWrap.appendChild(el('span', { class: 'sheet-label' }, ['When']));
  const timeInput = el('input', {
    type: 'datetime-local',
    class: 'sheet-time',
    id: 'sheet-time',
    value: s.eatenAtLocal,
  }) as HTMLInputElement;
  timeInput.addEventListener('input', () => {
    if (sheet) sheet.eatenAtLocal = timeInput.value;
  });
  timeWrap.appendChild(timeInput);
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
  // Auto-grow once on open for pre-filled edit.
  setTimeout(autoGrow, 0);

  // Photos area.
  const photosWrap = el('div', { class: 'sheet-field' });
  photosWrap.appendChild(el('span', { class: 'sheet-label' }, ['Photos']));

  const thumbs = el('div', { class: 'sheet-thumbs' });

  // Existing (server) photos first.
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

  // Draft (newly picked) photos.
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
    // Reorder arrows (only if >1 draft).
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

  // Add-photo button + hidden file input.
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

  // Footer: Save (disabled until saveable) + Cancel.
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

  // Helper to flip save-button disabled without full re-render on text input.
  function updateSaveButton(): void {
    if (!sheet) return;
    if (sheetIsSaveable(sheet)) {
      saveBtn.removeAttribute('disabled');
    } else {
      saveBtn.setAttribute('disabled', 'true');
    }
  }

  // Click outside panel = attempt close.
  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) closeSheet();
  });

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

  // Edit (only for real saved meals — pending ones lack a server id).
  if (!m.pending) {
    const editBtn = el(
      'button',
      { class: 'lightbox-edit', type: 'button', 'aria-label': 'Edit meal' },
      ['Edit']
    );
    editBtn.addEventListener('click', () => openSheetForEdit(m));
    actions.appendChild(editBtn);

    // Hold-to-delete (mirrors workout-tracker clear-data pattern).
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
            // Delete photos from storage first (best-effort), then row.
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

  // Tap background (outside inner) to close.
  root.addEventListener('click', (ev) => {
    if (ev.target === root) closeLightbox();
  });

  return root;
}

// ─── Boot ──────────────────────────────────────────────────────────────────

async function boot(): Promise<void> {
  render(); // initial paint: empty state + add-meal button
  try {
    meals = await fetchMeals();
    sortMeals();
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
