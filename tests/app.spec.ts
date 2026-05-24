import { test, expect, type Page, type Route } from '@playwright/test';

// 1x1 JPEG fixture for fake file uploads (photo picker).
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
 *
 * v1.5: two tables — meals + meal_photos. Mock keeps an in-memory list per
 * page-context so multi-step flows (insert meal → insert photo) compose.
 */
async function mockSupabase(page: Page): Promise<void> {
  const meals: Array<{
    id: string;
    eaten_at: string;
    description: string | null;
  }> = [];
  const mealPhotos: Array<{
    id: string;
    meal_id: string;
    photo_path: string;
    position: number;
  }> = [];

  await page.route(/supabase\.co\/rest\/v1\/meals(\?.*)?$/, async (route: Route) => {
    const method = route.request().method();
    const url = new URL(route.request().url());
    if (method === 'GET') {
      // Naive: return all meals; order by eaten_at desc.
      const sorted = [...meals].sort(
        (a, b) => new Date(b.eaten_at).getTime() - new Date(a.eaten_at).getTime()
      );
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(sorted),
      });
      return;
    }
    if (method === 'POST') {
      const body = JSON.parse(route.request().postData() || '{}') as {
        eaten_at: string;
        description: string | null;
      };
      const row = {
        id: 'mock-meal-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
        eaten_at: body.eaten_at,
        description: body.description ?? null,
      };
      meals.push(row);
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify([row]),
      });
      return;
    }
    if (method === 'PATCH') {
      const idMatch = url.searchParams.get('id');
      const id = idMatch?.replace(/^eq\./, '') ?? '';
      const body = JSON.parse(route.request().postData() || '{}') as {
        eaten_at?: string;
        description?: string | null;
      };
      const target = meals.find((m) => m.id === id);
      if (target) {
        if (body.eaten_at !== undefined) target.eaten_at = body.eaten_at;
        if (body.description !== undefined) target.description = body.description;
      }
      await route.fulfill({ status: 204, body: '' });
      return;
    }
    if (method === 'DELETE') {
      const idMatch = url.searchParams.get('id');
      const id = idMatch?.replace(/^eq\./, '') ?? '';
      const idx = meals.findIndex((m) => m.id === id);
      if (idx >= 0) meals.splice(idx, 1);
      // Cascade in mock.
      for (let i = mealPhotos.length - 1; i >= 0; i--) {
        if (mealPhotos[i].meal_id === id) mealPhotos.splice(i, 1);
      }
      await route.fulfill({ status: 204, body: '' });
      return;
    }
    await route.continue();
  });

  await page.route(/supabase\.co\/rest\/v1\/meal_photos(\?.*)?$/, async (route: Route) => {
    const method = route.request().method();
    const url = new URL(route.request().url());
    if (method === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([...mealPhotos].sort((a, b) => a.position - b.position)),
      });
      return;
    }
    if (method === 'POST') {
      const body = JSON.parse(route.request().postData() || '{}') as {
        meal_id: string;
        photo_path: string;
        position: number;
      };
      const row = {
        id: 'mock-photo-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
        meal_id: body.meal_id,
        photo_path: body.photo_path,
        position: body.position,
      };
      mealPhotos.push(row);
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify([row]),
      });
      return;
    }
    if (method === 'DELETE') {
      const idMatch = url.searchParams.get('id');
      const id = idMatch?.replace(/^eq\./, '') ?? '';
      const idx = mealPhotos.findIndex((p) => p.id === id);
      if (idx >= 0) mealPhotos.splice(idx, 1);
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
  // Auto-accept the "Discard?" confirm if it fires (it shouldn't in happy paths).
  page.on('dialog', (dialog) => {
    void dialog.accept();
  });
  await page.goto('/');
});

test('home screen renders title + add-meal button + empty today', async ({ page }) => {
  await expect(page.locator('h1')).toHaveText('Food Log');
  await expect(page.locator('#add-meal-btn')).toBeVisible();
  await expect(page.locator('.today-empty')).toContainText('No meals yet today');
});

test('add-meal button opens the meal-entry sheet with time + textarea + add-photo', async ({
  page,
}) => {
  await page.locator('#add-meal-btn').click();
  await expect(page.locator('.sheet-panel')).toBeVisible();
  const timeInput = page.locator('#sheet-time');
  await expect(timeInput).toHaveAttribute('type', 'datetime-local');
  await expect(timeInput).not.toHaveValue('');
  await expect(page.locator('#sheet-desc')).toBeVisible();
  await expect(page.locator('#sheet-add-photo')).toBeVisible();
  // The hidden photo input pre-selects rear camera on phones.
  const photoInput = page.locator('#sheet-photo-input');
  await expect(photoInput).toHaveAttribute('accept', 'image/*');
  await expect(photoInput).toHaveAttribute('capture', 'environment');
});

test('Save button is disabled when both description and photos are empty', async ({ page }) => {
  await page.locator('#add-meal-btn').click();
  const save = page.locator('#sheet-save');
  await expect(save).toBeDisabled();
});

test('Save button enables once description is typed', async ({ page }) => {
  await page.locator('#add-meal-btn').click();
  await page.locator('#sheet-desc').fill('chicken salad with hummus');
  await expect(page.locator('#sheet-save')).toBeEnabled();
});

test('Save button enables once a photo is added (no text)', async ({ page }) => {
  await page.locator('#add-meal-btn').click();
  await page.locator('#sheet-photo-input').setInputFiles({
    name: 'meal.jpg',
    mimeType: 'image/jpeg',
    buffer: tinyJpeg(),
  });
  await expect(page.locator('.sheet-thumb-draft')).toHaveCount(1);
  await expect(page.locator('#sheet-save')).toBeEnabled();
});

test('save a description-only meal (no photos)', async ({ page }) => {
  await page.locator('#add-meal-btn').click();
  await page.locator('#sheet-desc').fill('two eggs and toast');
  await page.locator('#sheet-save').click();

  // Sheet closes, meal card appears in today list with the description preview.
  await expect(page.locator('.sheet-panel')).toHaveCount(0);
  const firstCard = page.locator('.meal-list .meal-card').first();
  await expect(firstCard).toBeVisible({ timeout: 5000 });
  await expect(firstCard.locator('.meal-card-desc')).toContainText('two eggs and toast');
  // No photo strip when no photos.
  await expect(firstCard.locator('.meal-card-photos')).toHaveCount(0);
  await expect(page.locator('.toast')).toContainText(/saved/);
});

test('save a meal with one photo + description', async ({ page }) => {
  await page.locator('#add-meal-btn').click();
  await page.locator('#sheet-desc').fill('avocado toast');
  await page.locator('#sheet-photo-input').setInputFiles({
    name: 'meal.jpg',
    mimeType: 'image/jpeg',
    buffer: tinyJpeg(),
  });
  await page.locator('#sheet-save').click();

  const firstCard = page.locator('.meal-list .meal-card').first();
  await expect(firstCard).toBeVisible({ timeout: 5000 });
  await expect(firstCard.locator('.meal-card-desc')).toContainText('avocado toast');
  await expect(firstCard.locator('.meal-card-photo')).toHaveCount(1);
});

test('save a meal with multiple photos + description', async ({ page }) => {
  await page.locator('#add-meal-btn').click();
  await page.locator('#sheet-desc').fill('lunch spread');
  const input = page.locator('#sheet-photo-input');
  await input.setInputFiles({ name: 'a.jpg', mimeType: 'image/jpeg', buffer: tinyJpeg() });
  await input.setInputFiles({ name: 'b.jpg', mimeType: 'image/jpeg', buffer: tinyJpeg() });
  await input.setInputFiles({ name: 'c.jpg', mimeType: 'image/jpeg', buffer: tinyJpeg() });
  await expect(page.locator('.sheet-thumb-draft')).toHaveCount(3);
  await page.locator('#sheet-save').click();

  const firstCard = page.locator('.meal-list .meal-card').first();
  await expect(firstCard).toBeVisible({ timeout: 5000 });
  await expect(firstCard.locator('.meal-card-photo')).toHaveCount(3);
});

test('time field defaults to now (today) and is editable', async ({ page }) => {
  await page.locator('#add-meal-btn').click();
  const time = page.locator('#sheet-time');
  const defaultVal = await time.inputValue();
  // datetime-local format: YYYY-MM-DDTHH:mm — must be today's date.
  const today = new Date();
  const yyyy = today.getFullYear().toString();
  const mo = (today.getMonth() + 1).toString().padStart(2, '0');
  const da = today.getDate().toString().padStart(2, '0');
  expect(defaultVal.startsWith(`${yyyy}-${mo}-${da}T`)).toBe(true);

  // Editing it should stick.
  const edited = `${yyyy}-${mo}-${da}T08:30`;
  await time.fill(edited);
  await expect(time).toHaveValue(edited);
});

test('meal count on Today card updates after saves', async ({ page }) => {
  // First meal.
  await page.locator('#add-meal-btn').click();
  await page.locator('#sheet-desc').fill('a');
  await page.locator('#sheet-save').click();
  await expect(page.locator('.card-meta').first()).toContainText('1 meal');

  // Second meal.
  await page.locator('#add-meal-btn').click();
  await page.locator('#sheet-desc').fill('b');
  await page.locator('#sheet-save').click();
  await expect(page.locator('.card-meta').first()).toContainText('2 meals');
});

test('tapping a meal card opens the lightbox with time, description, edit, close', async ({
  page,
}) => {
  await page.locator('#add-meal-btn').click();
  await page.locator('#sheet-desc').fill('grilled salmon');
  await page.locator('#sheet-save').click();
  await page.locator('.meal-list .meal-card').first().click();
  await expect(page.locator('.lightbox')).toBeVisible();
  await expect(page.locator('.lightbox-time')).toHaveText(/^\d{2}:\d{2}$/);
  await expect(page.locator('.lightbox-desc')).toContainText('grilled salmon');
  await expect(page.locator('.lightbox-edit')).toBeVisible();
  await expect(page.locator('.lightbox-close')).toBeVisible();
  await page.locator('.lightbox-close').click();
  await expect(page.locator('.lightbox')).toHaveCount(0);
});

test('editing a meal changes the description', async ({ page }) => {
  await page.locator('#add-meal-btn').click();
  await page.locator('#sheet-desc').fill('original text');
  await page.locator('#sheet-save').click();
  await page.locator('.meal-list .meal-card').first().click();
  await page.locator('.lightbox-edit').click();
  await expect(page.locator('.sheet-panel')).toBeVisible();
  // Edit dialog pre-populated.
  await expect(page.locator('#sheet-desc')).toHaveValue('original text');
  await page.locator('#sheet-desc').fill('edited text');
  await page.locator('#sheet-save').click();
  // Card now shows the new text.
  const firstCard = page.locator('.meal-list .meal-card').first();
  await expect(firstCard.locator('.meal-card-desc')).toContainText('edited text');
});

test('editing a meal can add a new photo', async ({ page }) => {
  // Start with a description-only meal.
  await page.locator('#add-meal-btn').click();
  await page.locator('#sheet-desc').fill('breakfast');
  await page.locator('#sheet-save').click();
  // Open lightbox → edit.
  await page.locator('.meal-list .meal-card').first().click();
  await page.locator('.lightbox-edit').click();
  // Add a photo.
  await page.locator('#sheet-photo-input').setInputFiles({
    name: 'b.jpg',
    mimeType: 'image/jpeg',
    buffer: tinyJpeg(),
  });
  await expect(page.locator('.sheet-thumb-draft')).toHaveCount(1);
  await page.locator('#sheet-save').click();
  // Card now has 1 photo.
  await expect(
    page.locator('.meal-list .meal-card').first().locator('.meal-card-photo')
  ).toHaveCount(1);
});

test('editing a meal can remove a photo', async ({ page }) => {
  // Save a meal with 2 photos.
  await page.locator('#add-meal-btn').click();
  await page.locator('#sheet-desc').fill('lunch');
  const input = page.locator('#sheet-photo-input');
  await input.setInputFiles({ name: 'a.jpg', mimeType: 'image/jpeg', buffer: tinyJpeg() });
  await input.setInputFiles({ name: 'b.jpg', mimeType: 'image/jpeg', buffer: tinyJpeg() });
  await page.locator('#sheet-save').click();
  await expect(
    page.locator('.meal-list .meal-card').first().locator('.meal-card-photo')
  ).toHaveCount(2);

  // Open edit, remove one.
  await page.locator('.meal-list .meal-card').first().click();
  await page.locator('.lightbox-edit').click();
  // 2 existing photos in the sheet (non-draft).
  const existingThumbs = page.locator('.sheet-thumb:not(.sheet-thumb-draft)');
  await expect(existingThumbs).toHaveCount(2);
  await existingThumbs.first().locator('.sheet-thumb-remove').click();
  await page.locator('#sheet-save').click();

  // Card now has 1 photo.
  await expect(
    page.locator('.meal-list .meal-card').first().locator('.meal-card-photo')
  ).toHaveCount(1);
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
  expect(body).toContain('food-log-v1-5');
  expect(body).toContain('./dist/app.js');
  expect(body).toContain('./manifest.webmanifest');
});
