import { test, expect, type Page, type Route } from '@playwright/test';

// 1x1 JPEG fixture for fake file uploads (camera input).
function tinyJpeg(): Buffer {
  // Smallest valid JPEG payload.
  return Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
    0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08,
    0x07, 0x07, 0x07, 0x09, 0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12,
    0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20, 0x24, 0x2e, 0x27, 0x20,
    0x22, 0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29, 0x2c, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1f, 0x27,
    0x39, 0x3d, 0x38, 0x32, 0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01,
    0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4, 0x00, 0x1f, 0x00, 0x00, 0x01, 0x05, 0x01, 0x01,
    0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04,
    0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0xff, 0xc4, 0x00, 0xb5, 0x10, 0x00, 0x02, 0x01, 0x03,
    0x03, 0x02, 0x04, 0x03, 0x05, 0x05, 0x04, 0x04, 0x00, 0x00, 0x01, 0x7d, 0x01, 0x02, 0x03, 0x00,
    0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32,
    0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72,
    0x82, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0xfb, 0xd0, 0xff, 0xd9,
  ]);
}

/**
 * Mocks the Supabase REST + Storage endpoints so the tests don't hit the live
 * database. Mirrors the budget-app pattern of route-level mocking instead of
 * touching prod data.
 */
async function mockSupabase(page: Page): Promise<void> {
  await page.route(/supabase\.co\/rest\/v1\/food_entries.*/, async (route: Route) => {
    const method = route.request().method();
    if (method === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
      return;
    }
    if (method === 'POST') {
      const body = JSON.parse(route.request().postData() || '{}') as {
        eaten_at: string;
        photo_path: string;
      };
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'mock-id-' + Date.now(),
            eaten_at: body.eaten_at,
            photo_path: body.photo_path,
            notes: null,
          },
        ]),
      });
      return;
    }
    if (method === 'DELETE') {
      await route.fulfill({ status: 204, body: '' });
      return;
    }
    await route.continue();
  });

  await page.route(/supabase\.co\/storage\/v1\/object\/.*/, async (route: Route) => {
    const method = route.request().method();
    if (method === 'POST' || method === 'PUT') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ Key: 'food-photos/mock' }),
      });
      return;
    }
    if (method === 'DELETE') {
      await route.fulfill({ status: 200, body: '' });
      return;
    }
    if (method === 'GET') {
      // Public photo fetch — return a 1x1 jpeg so img renders.
      await route.fulfill({
        status: 200,
        contentType: 'image/jpeg',
        body: tinyJpeg(),
      });
      return;
    }
    await route.continue();
  });
}

test.beforeEach(async ({ page }) => {
  await mockSupabase(page);
  await page.addInitScript(() => {
    // Wipe any IDB queue from a previous test.
    indexedDB.deleteDatabase('food-log-queue');
  });
  await page.goto('/');
});

test('home screen renders title + camera button + empty today', async ({ page }) => {
  await expect(page.locator('h1')).toHaveText('Food Log');
  await expect(page.locator('#camera-btn')).toBeVisible();
  await expect(page.locator('.today-empty')).toContainText('No photos yet today');
});

test('camera button is wired to a hidden file input with capture=environment', async ({ page }) => {
  const input = page.locator('#camera-input');
  await expect(input).toHaveAttribute('accept', 'image/*');
  await expect(input).toHaveAttribute('capture', 'environment');
  await expect(input).toHaveAttribute('type', 'file');
});

test('header date label is present (defensive — proves the header renders)', async ({ page }) => {
  await expect(page.locator('.header-sub')).toBeVisible();
});

test('uploading a photo prepends it to today with HH:mm time', async ({ page }) => {
  const input = page.locator('#camera-input');
  await input.setInputFiles({
    name: 'meal.jpg',
    mimeType: 'image/jpeg',
    buffer: tinyJpeg(),
  });

  // First tile in today's strip = the just-uploaded photo, with a time label.
  const firstTile = page.locator('.today-strip .photo-tile').first();
  await expect(firstTile).toBeVisible({ timeout: 5000 });
  const timeText = await firstTile.locator('.photo-tile-time').textContent();
  expect(timeText).toMatch(/^\d{2}:\d{2}$/);

  // Toast indicates save succeeded.
  await expect(page.locator('.toast')).toContainText(/saved/);
});

test('photo count on Today card updates after upload', async ({ page }) => {
  const input = page.locator('#camera-input');
  await input.setInputFiles({
    name: 'meal.jpg',
    mimeType: 'image/jpeg',
    buffer: tinyJpeg(),
  });
  await expect(page.locator('.card-meta').first()).toContainText('1 photo');

  await input.setInputFiles({
    name: 'meal2.jpg',
    mimeType: 'image/jpeg',
    buffer: tinyJpeg(),
  });
  await expect(page.locator('.card-meta').first()).toContainText('2 photos');
});

test('tapping a thumbnail opens the lightbox with time + close button', async ({ page }) => {
  const input = page.locator('#camera-input');
  await input.setInputFiles({
    name: 'meal.jpg',
    mimeType: 'image/jpeg',
    buffer: tinyJpeg(),
  });
  await page.locator('.today-strip .photo-tile').first().click();
  await expect(page.locator('.lightbox')).toBeVisible();
  await expect(page.locator('.lightbox-time')).toHaveText(/^\d{2}:\d{2}$/);
  await expect(page.locator('.lightbox-close')).toBeVisible();
  await page.locator('.lightbox-close').click();
  await expect(page.locator('.lightbox')).toHaveCount(0);
});

test('history section renders prior days when entries exist for them', async ({ browser }) => {
  // Use a fresh context so the service worker from beforeEach's empty-fetch
  // doesn't return a cached empty list ahead of our seeded mock.
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route(/supabase\.co\/rest\/v1\/food_entries.*/, async (route: Route) => {
    const method = route.request().method();
    if (method === 'GET') {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      yesterday.setHours(12, 30, 0, 0);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'hist-1',
            eaten_at: yesterday.toISOString(),
            photo_path: '2026/05/hist-1.jpg',
            notes: null,
          },
        ]),
      });
      return;
    }
    await route.continue();
  });
  await page.route(/supabase\.co\/storage\/v1\/object\/.*/, async (route: Route) => {
    await route.fulfill({ status: 200, contentType: 'image/jpeg', body: tinyJpeg() });
  });
  await page.goto('/');
  const yesterdayPanel = page.locator('.history-day').first();
  await expect(yesterdayPanel).toBeVisible();
  await expect(yesterdayPanel.locator('.history-day-title')).toHaveText('Yesterday');
  await expect(yesterdayPanel.locator('.history-day-count')).toContainText('1 photo');
  await context.close();
});

test('manifest.webmanifest is served and lists the right name + theme color', async ({ page }) => {
  const res = await page.request.get('/manifest.webmanifest');
  expect(res.ok()).toBeTruthy();
  const manifest = (await res.json()) as { name: string; theme_color: string; icons: unknown[] };
  expect(manifest.name).toBe('Food Log');
  expect(manifest.theme_color).toBe('#fff4e6');
  expect(Array.isArray(manifest.icons)).toBe(true);
  expect(manifest.icons.length).toBeGreaterThanOrEqual(4);
});

test('repo ships rasterized PNG icons that the manifest references', async ({ page }) => {
  // Fetch each icon via the dev server — a missing PNG file shows up as 404.
  for (const f of ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'icon.svg']) {
    const res = await page.request.get(`/${f}`);
    expect(res.ok(), `${f} should be served`).toBeTruthy();
    const buf = await res.body();
    expect(buf.length).toBeGreaterThan(0);
  }
});

test('service worker file is served at /sw.js and references our shell assets', async ({
  page,
}) => {
  const res = await page.request.get('/sw.js');
  expect(res.ok()).toBeTruthy();
  const body = await res.text();
  expect(body).toContain('food-log-v1');
  expect(body).toContain('./dist/app.js');
  expect(body).toContain('./manifest.webmanifest');
});
