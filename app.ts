/**
 * food-log — v1.
 *
 * Scope (Allison's own words): "everything that day for now, food and time,
 * that's it. As we gain data we can improve. Has to be in phone app."
 *
 * One screen. Tap camera → snap meal → photo + auto-timestamp save → see today
 * with times. No macros, no AI analysis, no typing.
 *
 * Storage: Supabase Storage bucket `food-photos` (public, mirrors single-user
 * setup of sibling apps), Supabase table `food_entries` for metadata. Offline
 * captures queue in IndexedDB and drain on next online tick.
 *
 * v2-ready hooks:
 *   - `notes` column nullable on `food_entries` (future AI captions / typed notes)
 *   - photo path structured `{yyyy}/{mm}/{uuid}.jpg` so vision models can later
 *     fetch deterministically via Storage public URL
 */

// ─── Config ─────────────────────────────────────────────────────────────────

const SB_URL = 'https://hpiyvnfhoqnnnotrmwaz.supabase.co';
const SB_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhwaXl2bmZob3Fubm5vdHJtd2F6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI0NzIwNDEsImV4cCI6MjA4ODA0ODA0MX0.AsGhYitkSnyVMwpJII05UseS_gICaXiCy7d8iHsr6Qw';

const BUCKET = 'food-photos';
const TABLE = 'food_entries';
const HISTORY_DAYS = 30;
const IDB_NAME = 'food-log-queue';
const IDB_STORE = 'pending';

// ─── Types ──────────────────────────────────────────────────────────────────

interface FoodEntry {
  id: string;
  eaten_at: string; // ISO timestamp
  photo_path: string; // storage object key (e.g. 2026/05/uuid.jpg)
  photo_url: string; // resolved public URL
  notes: string | null;
  pending: boolean; // true if still queued locally
}

interface PendingItem {
  localId: string;
  blob: Blob;
  eaten_at: string;
  photo_path: string;
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

let entries: FoodEntry[] = [];
let lightboxEntry: FoodEntry | null = null;

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

// ─── IndexedDB offline queue ────────────────────────────────────────────────

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE, { keyPath: 'localId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function queuePending(item: PendingItem): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function readPending(): Promise<PendingItem[]> {
  const db = await openDb();
  const result = await new Promise<PendingItem[]>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).getAll();
    req.onsuccess = () => resolve(req.result as PendingItem[]);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return result;
}

async function removePending(localId: string): Promise<void> {
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

async function insertEntry(eatenAt: string, photoPath: string): Promise<FoodEntry> {
  const res = await fetch(`${SB_URL}/rest/v1/${TABLE}`, {
    method: 'POST',
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({ eaten_at: eatenAt, photo_path: photoPath }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`insert failed (${res.status}): ${text}`);
  }
  const rows = (await res.json()) as Array<{
    id: string;
    eaten_at: string;
    photo_path: string;
    notes: string | null;
  }>;
  const row = rows[0];
  return {
    id: row.id,
    eaten_at: row.eaten_at,
    photo_path: row.photo_path,
    photo_url: publicPhotoUrl(row.photo_path),
    notes: row.notes,
    pending: false,
  };
}

async function deleteEntry(entry: FoodEntry): Promise<void> {
  // Delete row first; bucket object cleanup is best-effort (orphan storage
  // doesn't break the app, but a deleted row that still appears in queries does).
  const rowRes = await fetch(`${SB_URL}/rest/v1/${TABLE}?id=eq.${encodeURIComponent(entry.id)}`, {
    method: 'DELETE',
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
    },
  });
  if (!rowRes.ok) {
    const text = await rowRes.text();
    throw new Error(`delete row failed (${rowRes.status}): ${text}`);
  }
  // Storage object — fire-and-forget; tolerate failure.
  try {
    await fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${entry.photo_path}`, {
      method: 'DELETE',
      headers: {
        apikey: SB_KEY,
        Authorization: `Bearer ${SB_KEY}`,
      },
    });
  } catch (err) {
    console.warn('[food-log] storage delete failed (row already gone):', err);
  }
}

async function fetchEntries(): Promise<FoodEntry[]> {
  const since = new Date();
  since.setDate(since.getDate() - HISTORY_DAYS);
  since.setHours(0, 0, 0, 0);
  const url =
    `${SB_URL}/rest/v1/${TABLE}` +
    `?select=id,eaten_at,photo_path,notes` +
    `&eaten_at=gte.${encodeURIComponent(since.toISOString())}` +
    `&order=eaten_at.desc`;
  const res = await fetch(url, {
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`fetch failed (${res.status}): ${text}`);
  }
  const rows = (await res.json()) as Array<{
    id: string;
    eaten_at: string;
    photo_path: string;
    notes: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    eaten_at: r.eaten_at,
    photo_path: r.photo_path,
    photo_url: publicPhotoUrl(r.photo_path),
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

// ─── Drain offline queue ────────────────────────────────────────────────────

let draining = false;
async function drainQueue(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    const pending = await readPending();
    for (const item of pending) {
      try {
        await uploadPhoto(item.blob, item.photo_path);
        const saved = await insertEntry(item.eaten_at, item.photo_path);
        await removePending(item.localId);
        // Replace any optimistic-pending entry with the real one.
        entries = entries.filter((e) => e.id !== item.localId);
        entries.unshift(saved);
      } catch (err) {
        console.warn('[food-log] queue drain item failed (will retry later):', err);
        // Stop on first failure — likely offline again or rate-limited.
        break;
      }
    }
    sortEntries();
    render();
  } finally {
    draining = false;
    updateQueueBanner();
  }
}

async function updateQueueBanner(): Promise<void> {
  const banner = $('.queue-banner');
  if (!banner) return;
  const count = (await readPending().catch(() => [])).length;
  if (count > 0) {
    banner.textContent = `${count} photo${count === 1 ? '' : 's'} queued — will upload when online`;
    banner.classList.add('visible');
  } else {
    banner.classList.remove('visible');
  }
}

// ─── Capture flow ───────────────────────────────────────────────────────────

async function onPhotoSelected(file: File): Promise<void> {
  const eatenAt = new Date();
  const path = buildPhotoPath(eatenAt);
  const localId = uuid();

  // Optimistic UI — show immediately as pending.
  const blobUrl = URL.createObjectURL(file);
  const optimistic: FoodEntry = {
    id: localId,
    eaten_at: eatenAt.toISOString(),
    photo_path: path,
    photo_url: blobUrl,
    notes: null,
    pending: true,
  };
  entries.unshift(optimistic);
  render();
  toast('uploading…');

  try {
    await uploadPhoto(file, path);
    const saved = await insertEntry(eatenAt.toISOString(), path);
    entries = entries.filter((e) => e.id !== localId);
    entries.unshift(saved);
    sortEntries();
    render();
    toast('saved ✓');
  } catch (err) {
    console.warn('[food-log] upload failed, queueing locally:', err);
    // Persist the blob for retry.
    await queuePending({ localId, blob: file, eaten_at: eatenAt.toISOString(), photo_path: path });
    // Keep optimistic in view; flag as pending in render via the photo_url we already have.
    toast('saved offline — will upload later', 2500);
  } finally {
    updateQueueBanner();
  }
}

function sortEntries(): void {
  entries.sort((a, b) => new Date(b.eaten_at).getTime() - new Date(a.eaten_at).getTime());
}

// ─── Render ─────────────────────────────────────────────────────────────────

function groupByDay(items: FoodEntry[]): Map<number, FoodEntry[]> {
  const map = new Map<number, FoodEntry[]>();
  for (const e of items) {
    const key = startOfLocalDay(e.eaten_at);
    const arr = map.get(key) ?? [];
    arr.push(e);
    map.set(key, arr);
  }
  return map;
}

function renderPhotoTile(e: FoodEntry): HTMLElement {
  const tile = el('button', {
    class: 'photo-tile',
    type: 'button',
    'data-entry-id': e.id,
    'aria-label': `Photo from ${formatTime(e.eaten_at)}`,
  });
  const img = el('img', {
    src: e.photo_url,
    alt: '',
    loading: 'lazy',
  }) as HTMLImageElement;
  tile.appendChild(img);
  tile.appendChild(el('span', { class: 'photo-tile-time' }, [formatTime(e.eaten_at)]));
  if (e.pending) {
    tile.appendChild(el('span', { class: 'photo-tile-pending' }, ['queued']));
  }
  tile.addEventListener('click', () => openLightbox(e));
  return tile;
}

function render(): void {
  const root = $('#app');
  if (!root) return;
  root.innerHTML = '';

  const today = startOfLocalDay(new Date().toISOString());
  const grouped = groupByDay(entries);
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
      `${todayItems.length} ${todayItems.length === 1 ? 'photo' : 'photos'}`,
    ])
  );
  todayCard.appendChild(todayHeader);

  if (todayItems.length === 0) {
    todayCard.appendChild(
      el('div', { class: 'today-empty' }, ['No photos yet today. Tap the camera to start.'])
    );
  } else {
    const strip = el('div', { class: 'today-strip' });
    for (const e of todayItems) strip.appendChild(renderPhotoTile(e));
    todayCard.appendChild(strip);
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
          `${items.length} ${items.length === 1 ? 'photo' : 'photos'}`,
        ])
      );
      details.appendChild(summary);
      const body = el('div', { class: 'history-day-body' });
      const strip = el('div', { class: 'today-strip' });
      for (const e of items) strip.appendChild(renderPhotoTile(e));
      body.appendChild(strip);
      details.appendChild(body);
      hist.appendChild(details);
    }
    app.appendChild(hist);
  } else if (todayItems.length > 0) {
    app.appendChild(el('div', { class: 'history-empty' }, ['No earlier days yet — keep going.']));
  }

  // Floating camera button
  const fab = el('div', { class: 'camera-fab' });
  const fabBtn = el(
    'button',
    {
      class: 'camera-fab-btn',
      type: 'button',
      id: 'camera-btn',
      'aria-label': 'Take photo of food',
    },
    [el('span', { class: 'camera-icon', 'aria-hidden': 'true' }, ['📷']), 'Snap a meal']
  );
  fab.appendChild(fabBtn);

  // Hidden file input wired to the camera button.
  const input = el('input', {
    type: 'file',
    accept: 'image/*',
    capture: 'environment',
    class: 'camera-input-hidden',
    id: 'camera-input',
  }) as HTMLInputElement;
  fab.appendChild(input);

  fabBtn.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    if (file) {
      void onPhotoSelected(file);
    }
    input.value = ''; // allow re-selecting the same file
  });

  app.appendChild(fab);
  root.appendChild(app);

  if (lightboxEntry) {
    root.appendChild(buildLightbox(lightboxEntry));
  }

  void updateQueueBanner();
}

// ─── Lightbox ──────────────────────────────────────────────────────────────

function openLightbox(e: FoodEntry): void {
  lightboxEntry = e;
  render();
}

function closeLightbox(): void {
  lightboxEntry = null;
  render();
}

function buildLightbox(e: FoodEntry): HTMLElement {
  const root = el('div', { class: 'lightbox', role: 'dialog', 'aria-modal': 'true' });
  const img = el('img', { src: e.photo_url, alt: '' });
  root.appendChild(img);
  root.appendChild(el('div', { class: 'lightbox-time' }, [formatTime(e.eaten_at)]));

  const actions = el('div', { class: 'lightbox-actions' });
  const closeBtn = el('button', { class: 'lightbox-close', type: 'button' }, ['Close']);
  closeBtn.addEventListener('click', closeLightbox);
  actions.appendChild(closeBtn);

  // Delete: hold-to-confirm (mirrors workout-tracker clear-data pattern).
  // Only attached for real saved entries — optimistic / pending rows can't be
  // deleted server-side until they have a real id.
  if (!e.pending) {
    const delBtn = el('button', {
      class: 'lightbox-delete',
      type: 'button',
      'aria-label': 'Hold to delete photo',
    });
    delBtn.appendChild(el('span', { class: 'hold-fill' }));
    delBtn.appendChild(el('span', { class: 'lightbox-delete-label' }, ['Hold to delete']));

    let holdTimer: ReturnType<typeof setTimeout> | null = null;
    const startHold = (): void => {
      delBtn.classList.add('holding');
      holdTimer = setTimeout(() => {
        void (async () => {
          try {
            await deleteEntry(e);
            entries = entries.filter((x) => x.id !== e.id);
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

  root.appendChild(actions);

  // Tap background (not the image) to close.
  root.addEventListener('click', (ev) => {
    if (ev.target === root) closeLightbox();
  });

  return root;
}

// ─── Boot ──────────────────────────────────────────────────────────────────

async function boot(): Promise<void> {
  render(); // initial paint: empty state + camera button
  try {
    entries = await fetchEntries();
    sortEntries();
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
