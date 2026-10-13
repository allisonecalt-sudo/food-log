// food-log v3 — food CHAT suite (Oct 13 2026).
// Supabase REST + Storage are mocked at the route level so tests never touch
// the live database (page.fill on the real app would write PROD).
import { test, expect, type Page, type Route } from '@playwright/test';

interface Row {
  id: string;
  said_at: string;
  text: string | null;
  photo_path: string | null;
  handled_at: string | null;
}

// Smallest valid 1x1 PNG.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
  'base64'
);

async function mockSupabase(
  page: Page,
  opts: { seed?: Row[]; failInserts?: boolean } = {}
): Promise<{ rows: Row[]; uploads: string[] }> {
  const rows: Row[] = [...(opts.seed ?? [])];
  const uploads: string[] = [];

  await page.route('**/rest/v1/food_chat**', async (route: Route) => {
    const req = route.request();
    const method = req.method();
    if (method === 'GET') {
      await route.fulfill({ json: rows });
      return;
    }
    if (method === 'POST') {
      if (opts.failInserts) {
        await route.fulfill({ status: 503, body: 'down' });
        return;
      }
      const body = JSON.parse(req.postData() ?? '{}') as Partial<Row>;
      const row: Row = {
        id: body.id ?? 'x',
        said_at: body.said_at ?? new Date().toISOString(),
        text: body.text ?? null,
        photo_path: body.photo_path ?? null,
        handled_at: null,
      };
      rows.push(row);
      await route.fulfill({ status: 201, json: [row] });
      return;
    }
    if (method === 'DELETE') {
      const id = new URL(req.url()).searchParams.get('id')?.replace('eq.', '');
      const i = rows.findIndex((r) => r.id === id);
      if (i >= 0) rows.splice(i, 1);
      await route.fulfill({ status: 204, body: '' });
      return;
    }
    await route.fulfill({ status: 405, body: '' });
  });

  await page.route('**/storage/v1/object/**', async (route: Route) => {
    if (route.request().method() === 'POST') {
      uploads.push(route.request().url());
      await route.fulfill({ status: 200, json: { Key: 'ok' } });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'image/png', body: TINY_PNG });
  });

  return { rows, uploads };
}

test.beforeEach(async ({ context }) => {
  // Keep the service worker out of the way so route mocks always apply.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'serviceWorker', { value: undefined });
  });
});

test('empty chat shows the gentle prompt and the version tag', async ({ page }) => {
  await mockSupabase(page);
  await page.goto('/');
  await expect(page.locator('.thread-empty')).toHaveText('Just say what you ate.');
  await expect(page.locator('.app-version')).toContainText('v3.0');
});

test('typing and sending saves a row with the time and shows the bubble', async ({ page }) => {
  const db = await mockSupabase(page);
  await page.goto('/');
  await page.fill('#composer-input', '2 eggs and a coffee');
  await page.click('#send-btn');
  await expect(page.locator('.bubble-text')).toHaveText('2 eggs and a coffee');
  await expect(page.locator('.day-divider')).toHaveText('Today');
  await expect.poll(() => db.rows.length).toBe(1);
  expect(db.rows[0].text).toBe('2 eggs and a coffee');
  expect(db.rows[0].said_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  await expect(page.locator('#composer-input')).toHaveValue('');
});

test('empty send does nothing', async ({ page }) => {
  const db = await mockSupabase(page);
  await page.goto('/');
  await page.click('#send-btn');
  await expect(page.locator('.bubble')).toHaveCount(0);
  expect(db.rows.length).toBe(0);
});

test('a photo uploads to the chat folder and is saved on the row', async ({ page }) => {
  const db = await mockSupabase(page);
  await page.goto('/');
  await page.setInputFiles('#photo-input', {
    name: 'meal.png',
    mimeType: 'image/png',
    buffer: TINY_PNG,
  });
  await expect(page.locator('.photo-preview img')).toBeVisible();
  await page.click('#send-btn');
  await expect.poll(() => db.rows.length).toBe(1);
  expect(db.rows[0].photo_path).toMatch(/^chat\/\d{4}\/\d{2}\/.+\.jpg$/);
  expect(db.uploads[0]).toContain('/food-photos/chat/');
  await expect(page.locator('.bubble-photo')).toBeVisible();
});

test('seen messages show the quiet seen mark', async ({ page }) => {
  await mockSupabase(page, {
    seed: [
      {
        id: 'a1',
        said_at: new Date().toISOString(),
        text: 'shawarma',
        photo_path: null,
        handled_at: new Date().toISOString(),
      },
    ],
  });
  await page.goto('/');
  await expect(page.locator('.bubble-status')).toHaveText('✓ seen');
});

test('no signal keeps the text waiting instead of losing it', async ({ page }) => {
  await mockSupabase(page, { failInserts: true });
  await page.goto('/');
  await page.fill('#composer-input', 'rice cakes');
  await page.click('#send-btn');
  await expect(page.locator('.bubble-status')).toHaveText('waiting for signal');
  const pending = await page.evaluate(() => localStorage.getItem('food-chat-pending-text'));
  expect(pending).toContain('rice cakes');
});

test('delete removes the message', async ({ page }) => {
  const db = await mockSupabase(page, {
    seed: [
      {
        id: 'd1',
        said_at: new Date().toISOString(),
        text: 'typo',
        photo_path: null,
        handled_at: null,
      },
    ],
  });
  page.on('dialog', (d) => void d.accept());
  await page.goto('/');
  await page.click('.bubble-delete');
  await expect(page.locator('.bubble')).toHaveCount(0);
  expect(db.rows.length).toBe(0);
});
