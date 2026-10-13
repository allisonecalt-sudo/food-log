/**
 * food-log v3 — the food CHAT (Tue Oct 13 2026).
 *
 * Her spec, verbatim: "It's just a chat. I say what I say. I record it. However I
 * do it. Spoken, typed, whatever, picture. I just had it. It goes in. Nothing
 * responsible. I just chatted and chatted and chatted and then you look at it.
 * And yes questions." · "Honestly just override my food app I have now."
 *
 * So the app is ONE screen: a thread + a composer. Every message is a row in
 * `food_chat` (said_at, text, photo_path, handled_at). The app does NO sorting,
 * no calories, no fields. Claude reads the unhandled rows later, turns them into
 * `meals` rows, sets handled_at, and asks her questions in Claude Code.
 * handled_at shows here as a quiet "✓ seen" so she knows it was read.
 *
 * Speaking = her phone keyboard's mic button (no custom speech code needed).
 * The old v2.5 meals/weight/cook/notes/bowel app lives in git history
 * (commit 0d04af2); its tables are untouched.
 */

// ─── Config ─────────────────────────────────────────────────────────────────

const SB_URL = 'https://hpiyvnfhoqnnnotrmwaz.supabase.co';
const SB_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhwaXl2bmZob3Fubm5vdHJtd2F6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI0NzIwNDEsImV4cCI6MjA4ODA0ODA0MX0.AsGhYitkSnyVMwpJII05UseS_gICaXiCy7d8iHsr6Qw';

const BUCKET = 'food-photos';
const CHAT_TABLE = 'food_chat';
// BUMP ALL THREE TOGETHER — APP_VERSION, BUILD_DATE, and the sw.js VERSION — on every deploy.
const APP_VERSION = 'v3.0';
const BUILD_DATE = 'Oct 13, 2026';
const HISTORY_DAYS = 7;
const MAX_PHOTO_DIM = 1600;
const PENDING_KEY = 'food-chat-pending-text'; // local buffer only; Supabase is canonical

// ─── Types ──────────────────────────────────────────────────────────────────

interface ChatRow {
  id: string;
  said_at: string;
  text: string | null;
  photo_path: string | null;
  handled_at: string | null;
}

interface PendingText {
  localId: string;
  said_at: string;
  text: string;
}

type SendState = 'sent' | 'sending' | 'waiting';

interface Bubble {
  row: ChatRow;
  state: SendState;
  localPhotoUrl?: string;
}

// ─── State ──────────────────────────────────────────────────────────────────

let bubbles: Bubble[] = [];
let pickedPhoto: Blob | null = null;
let pickedPhotoUrl: string | null = null;
let loadError = false;

// ─── Helpers ────────────────────────────────────────────────────────────────

function uuid(): string {
  return crypto.randomUUID();
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, ...extra };
}

function photoUrl(path: string): string {
  return `${SB_URL}/storage/v1/object/public/${BUCKET}/${path}`;
}

function buildPhotoPath(now: Date): string {
  const yyyy = now.getFullYear().toString();
  const mm = (now.getMonth() + 1).toString().padStart(2, '0');
  return `chat/${yyyy}/${mm}/${uuid()}.jpg`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (dayKey(d.toISOString()) === dayKey(today.toISOString())) return 'Today';
  if (dayKey(d.toISOString()) === dayKey(yesterday.toISOString())) return 'Yesterday';
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

// ─── Local pending buffer (text only) ──────────────────────────────────────

function readPending(): PendingText[] {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    return raw ? (JSON.parse(raw) as PendingText[]) : [];
  } catch {
    return [];
  }
}

function writePending(items: PendingText[]): void {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(items));
  } catch {
    // Storage blocked — the bubble still shows "waiting"; nothing else to do.
  }
}

// ─── Supabase ───────────────────────────────────────────────────────────────

async function fetchRecent(): Promise<ChatRow[]> {
  const since = new Date();
  since.setDate(since.getDate() - HISTORY_DAYS);
  const url =
    `${SB_URL}/rest/v1/${CHAT_TABLE}` +
    `?select=id,said_at,text,photo_path,handled_at` +
    `&said_at=gte.${encodeURIComponent(since.toISOString())}` +
    `&order=said_at.asc`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) throw new Error(`load failed (${res.status})`);
  return (await res.json()) as ChatRow[];
}

async function insertRow(
  id: string,
  saidAt: string,
  text: string | null,
  photoPath: string | null
): Promise<ChatRow> {
  const res = await fetch(`${SB_URL}/rest/v1/${CHAT_TABLE}`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json', Prefer: 'return=representation' }),
    body: JSON.stringify({ id, said_at: saidAt, text, photo_path: photoPath }),
  });
  if (!res.ok) throw new Error(`save failed (${res.status})`);
  const rows = (await res.json()) as ChatRow[];
  return rows[0];
}

async function deleteRow(id: string): Promise<void> {
  const res = await fetch(`${SB_URL}/rest/v1/${CHAT_TABLE}?id=eq.${id}`, {
    method: 'DELETE',
    headers: headers(),
  });
  if (!res.ok) throw new Error(`delete failed (${res.status})`);
}

async function uploadPhoto(blob: Blob, path: string): Promise<void> {
  const res = await fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${path}`, {
    method: 'POST',
    headers: headers({ 'Content-Type': blob.type || 'image/jpeg', 'x-upsert': 'true' }),
    body: blob,
  });
  if (!res.ok) throw new Error(`photo upload failed (${res.status})`);
}

// ─── Photo shrink (phone photos are huge) ──────────────────────────────────

async function shrinkPhoto(file: Blob): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_PHOTO_DIM / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const out = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.82)
    );
    return out ?? file;
  } catch {
    return file;
  }
}

// ─── Sending ────────────────────────────────────────────────────────────────

async function flushPending(): Promise<void> {
  const pending = readPending();
  if (pending.length === 0) return;
  const left: PendingText[] = [];
  for (const p of pending) {
    try {
      const row = await insertRow(p.localId, p.said_at, p.text, null);
      const b = bubbles.find((x) => x.row.id === p.localId);
      if (b) {
        b.row = row;
        b.state = 'sent';
      }
    } catch {
      left.push(p);
    }
  }
  writePending(left);
  render();
}

async function send(): Promise<void> {
  const input = document.getElementById('composer-input') as HTMLTextAreaElement | null;
  const raw = input ? input.value.trim() : '';
  const photo = pickedPhoto;
  if (!raw && !photo) return;

  const id = uuid();
  const saidAt = new Date().toISOString();
  const text = raw || null;
  const bubble: Bubble = {
    row: { id, said_at: saidAt, text, photo_path: null, handled_at: null },
    state: 'sending',
    localPhotoUrl: pickedPhotoUrl ?? undefined,
  };
  bubbles.push(bubble);
  if (input) input.value = '';
  pickedPhoto = null;
  pickedPhotoUrl = null;
  render();
  scrollToEnd();

  try {
    let photoPath: string | null = null;
    if (photo) {
      photoPath = buildPhotoPath(new Date(saidAt));
      await uploadPhoto(photo, photoPath);
    }
    bubble.row = await insertRow(id, saidAt, text, photoPath);
    bubble.state = 'sent';
  } catch {
    if (photo) {
      // Photos can't wait in the local buffer — put it back so nothing is lost.
      bubbles = bubbles.filter((b) => b !== bubble);
      pickedPhoto = photo;
      pickedPhotoUrl = bubble.localPhotoUrl ?? null;
      if (input && text) input.value = text;
      showToast("Couldn't send — check the connection and tap send again");
    } else {
      bubble.state = 'waiting';
      writePending([...readPending(), { localId: id, said_at: saidAt, text: text ?? '' }]);
    }
  }
  render();
  scrollToEnd();
}

async function removeBubble(b: Bubble): Promise<void> {
  if (!window.confirm('Delete this message?')) return;
  if (b.state === 'waiting') {
    writePending(readPending().filter((p) => p.localId !== b.row.id));
  } else {
    try {
      await deleteRow(b.row.id);
    } catch {
      showToast("Couldn't delete — try again");
      return;
    }
  }
  bubbles = bubbles.filter((x) => x !== b);
  render();
}

// ─── Rendering ──────────────────────────────────────────────────────────────

function showToast(msg: string): void {
  const t = el('div', 'toast', msg);
  document.body.appendChild(t);
  window.setTimeout(() => t.remove(), 3500);
}

function scrollToEnd(): void {
  const thread = document.getElementById('thread');
  if (thread) thread.scrollTop = thread.scrollHeight;
}

function renderBubble(b: Bubble): HTMLElement {
  const wrap = el('div', 'bubble');
  wrap.dataset.id = b.row.id;
  const src = b.localPhotoUrl ?? (b.row.photo_path ? photoUrl(b.row.photo_path) : null);
  if (src) {
    const img = el('img', 'bubble-photo');
    img.src = src;
    img.alt = 'food photo';
    img.loading = 'lazy';
    wrap.appendChild(img);
  }
  if (b.row.text) {
    const p = el('p', 'bubble-text', b.row.text);
    p.dir = 'auto';
    wrap.appendChild(p);
  }
  const meta = el('div', 'bubble-meta');
  meta.appendChild(el('span', 'bubble-time', formatTime(b.row.said_at)));
  let status = '';
  if (b.state === 'sending') status = 'sending…';
  else if (b.state === 'waiting') status = 'waiting for signal';
  else if (b.row.handled_at) status = '✓ seen';
  if (status) meta.appendChild(el('span', `bubble-status status-${b.state}`, status));
  const del = el('button', 'bubble-delete', '×');
  del.type = 'button';
  del.setAttribute('aria-label', 'Delete message');
  del.addEventListener('click', () => void removeBubble(b));
  meta.appendChild(del);
  wrap.appendChild(meta);
  return wrap;
}

function renderThread(): HTMLElement {
  const thread = el('main', 'thread');
  thread.id = 'thread';
  if (loadError) {
    thread.appendChild(el('p', 'thread-note', "Couldn't load — you can still send"));
  }
  if (bubbles.length === 0 && !loadError) {
    thread.appendChild(el('p', 'thread-empty', 'Just say what you ate.'));
    return thread;
  }
  let lastDay = '';
  for (const b of bubbles) {
    const k = dayKey(b.row.said_at);
    if (k !== lastDay) {
      thread.appendChild(el('div', 'day-divider', dayLabel(b.row.said_at)));
      lastDay = k;
    }
    thread.appendChild(renderBubble(b));
  }
  return thread;
}

function renderComposer(): HTMLElement {
  const bar = el('footer', 'composer');

  if (pickedPhotoUrl) {
    const prev = el('div', 'photo-preview');
    const img = el('img');
    img.src = pickedPhotoUrl;
    img.alt = 'picked photo';
    const x = el('button', 'photo-remove', '×');
    x.type = 'button';
    x.setAttribute('aria-label', 'Remove photo');
    x.addEventListener('click', () => {
      pickedPhoto = null;
      pickedPhotoUrl = null;
      render();
    });
    prev.append(img, x);
    bar.appendChild(prev);
  }

  const row = el('div', 'composer-row');

  const file = el('input');
  file.type = 'file';
  file.accept = 'image/*';
  file.id = 'photo-input';
  file.className = 'visually-hidden';
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    if (!f) return;
    const input = document.getElementById('composer-input') as HTMLTextAreaElement | null;
    const draft = input ? input.value : '';
    pickedPhoto = await shrinkPhoto(f);
    pickedPhotoUrl = URL.createObjectURL(pickedPhoto);
    render();
    const again = document.getElementById('composer-input') as HTMLTextAreaElement | null;
    if (again) again.value = draft;
  });

  const cam = el('label', 'composer-camera', '📷');
  cam.htmlFor = 'photo-input';
  cam.setAttribute('aria-label', 'Add a photo');

  const input = el('textarea', 'composer-input');
  input.id = 'composer-input';
  input.rows = 1;
  input.placeholder = 'What did you eat?';
  input.dir = 'auto';
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
  });

  const sendBtn = el('button', 'composer-send', 'Send');
  sendBtn.id = 'send-btn';
  sendBtn.type = 'button';
  sendBtn.addEventListener('click', () => void send());

  row.append(file, cam, input, sendBtn);
  bar.appendChild(row);
  return bar;
}

function render(): void {
  const app = document.getElementById('app');
  if (!app) return;
  const input = document.getElementById('composer-input') as HTMLTextAreaElement | null;
  const draft = input ? input.value : '';
  const hadFocus = input !== null && document.activeElement === input;

  const header = el('header', 'app-header');
  header.appendChild(el('h1', 'app-title', '🍽 Food'));
  header.appendChild(el('span', 'app-version', `${APP_VERSION} · ${BUILD_DATE}`));

  app.replaceChildren(header, renderThread(), renderComposer());

  const fresh = document.getElementById('composer-input') as HTMLTextAreaElement | null;
  if (fresh) {
    fresh.value = draft;
    if (hadFocus) fresh.focus();
  }
}

// ─── Boot ───────────────────────────────────────────────────────────────────

async function boot(): Promise<void> {
  render();
  try {
    const rows = await fetchRecent();
    bubbles = rows.map((row) => ({ row, state: 'sent' as SendState }));
    loadError = false;
  } catch {
    loadError = true;
  }
  const known = new Set(bubbles.map((b) => b.row.id));
  // A pending text whose id already reached the DB (reply lost on the way back)
  // is done — drop it so it can't be sent twice.
  if (!loadError) writePending(readPending().filter((p) => !known.has(p.localId)));
  for (const p of readPending()) {
    if (!known.has(p.localId)) {
      bubbles.push({
        row: {
          id: p.localId,
          said_at: p.said_at,
          text: p.text,
          photo_path: null,
          handled_at: null,
        },
        state: 'waiting',
      });
    }
  }
  render();
  scrollToEnd();
  void flushPending();
}

window.addEventListener('online', () => void flushPending());
void boot();
