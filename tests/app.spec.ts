// food-log Playwright suite — v1.6.
//
// v1.6 changes vs v1.5.1:
//   - The split #sheet-date + #sheet-time inputs are now hidden behind the
//     Custom chip. Default is the Now chip — chip-row drives time at save.
//   - Sibling pill buttons replace the bottom FAB. #add-meal-btn is now the
//     header pill; #add-weight-btn is its sibling.
//   - New weight_log surface (table mocked below), quick-sheet with chip row +
//     numeric kg + optional notes; home section under meals.
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
  const weightLog: Array<{
    id: string;
    measured_at: string;
    weight_kg: number;
    notes: string | null;
  }> = [];
  const cookSessions: Array<{
    id: string;
    cooked_at: string;
    description: string | null;
    total_portions: number | null;
    notes: string | null;
  }> = [];
  const notesRows: Array<{
    id: string;
    noted_at: string;
    text: string;
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

  await page.route(/supabase\.co\/rest\/v1\/weight_log(\?.*)?$/, async (route: Route) => {
    const method = route.request().method();
    const url = new URL(route.request().url());
    if (method === 'GET') {
      const sorted = [...weightLog].sort(
        (a, b) => new Date(b.measured_at).getTime() - new Date(a.measured_at).getTime()
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
        measured_at: string;
        weight_kg: number;
        notes: string | null;
      };
      const row = {
        id: 'mock-weight-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
        measured_at: body.measured_at,
        weight_kg: body.weight_kg,
        notes: body.notes ?? null,
      };
      weightLog.push(row);
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
        measured_at?: string;
        weight_kg?: number;
        notes?: string | null;
      };
      const target = weightLog.find((w) => w.id === id);
      if (target) {
        if (body.measured_at !== undefined) target.measured_at = body.measured_at;
        if (body.weight_kg !== undefined) target.weight_kg = body.weight_kg;
        if (body.notes !== undefined) target.notes = body.notes;
      }
      await route.fulfill({ status: 204, body: '' });
      return;
    }
    if (method === 'DELETE') {
      const idMatch = url.searchParams.get('id');
      const id = idMatch?.replace(/^eq\./, '') ?? '';
      const idx = weightLog.findIndex((w) => w.id === id);
      if (idx >= 0) weightLog.splice(idx, 1);
      await route.fulfill({ status: 204, body: '' });
      return;
    }
    await route.continue();
  });

  await page.route(/supabase\.co\/rest\/v1\/cook_sessions(\?.*)?$/, async (route: Route) => {
    const method = route.request().method();
    const url = new URL(route.request().url());
    if (method === 'GET') {
      const sorted = [...cookSessions].sort(
        (a, b) => new Date(b.cooked_at).getTime() - new Date(a.cooked_at).getTime()
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
        cooked_at: string;
        description: string | null;
        total_portions: number | null;
        notes: string | null;
      };
      const row = {
        id: 'mock-cook-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
        cooked_at: body.cooked_at,
        description: body.description ?? null,
        total_portions: body.total_portions ?? null,
        notes: body.notes ?? null,
      };
      cookSessions.push(row);
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
      const body = JSON.parse(route.request().postData() || '{}') as Partial<{
        cooked_at: string;
        description: string | null;
        total_portions: number | null;
        notes: string | null;
      }>;
      const target = cookSessions.find((c) => c.id === id);
      if (target) {
        if (body.cooked_at !== undefined) target.cooked_at = body.cooked_at;
        if (body.description !== undefined) target.description = body.description;
        if (body.total_portions !== undefined) target.total_portions = body.total_portions;
        if (body.notes !== undefined) target.notes = body.notes;
      }
      await route.fulfill({ status: 204, body: '' });
      return;
    }
    if (method === 'DELETE') {
      const idMatch = url.searchParams.get('id');
      const id = idMatch?.replace(/^eq\./, '') ?? '';
      const idx = cookSessions.findIndex((c) => c.id === id);
      if (idx >= 0) cookSessions.splice(idx, 1);
      await route.fulfill({ status: 204, body: '' });
      return;
    }
    await route.continue();
  });

  await page.route(/supabase\.co\/rest\/v1\/notes(\?.*)?$/, async (route: Route) => {
    const method = route.request().method();
    const url = new URL(route.request().url());
    if (method === 'GET') {
      const sorted = [...notesRows].sort(
        (a, b) => new Date(b.noted_at).getTime() - new Date(a.noted_at).getTime()
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
        noted_at: string;
        text: string;
      };
      const row = {
        id: 'mock-note-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
        noted_at: body.noted_at,
        text: body.text,
      };
      notesRows.push(row);
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
      const idx = notesRows.findIndex((n) => n.id === id);
      if (idx >= 0) notesRows.splice(idx, 1);
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
  // Disable the service worker for tests. When the SW is active it intercepts
  // Supabase REST GETs (network-first cache) and our page.route mocks lose
  // the race for those requests — meal_photos in particular slipped through
  // to the live server in v1.5 tests. Killing navigator.serviceWorker
  // pre-script keeps the SW registration call a no-op.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'serviceWorker', {
      value: undefined,
      configurable: true,
    });
    // Wipe any IDB queue from a previous test.
    indexedDB.deleteDatabase('food-log-queue');
  });
  await mockSupabase(page);
  // Auto-accept the "Discard?" confirm if it fires (it shouldn't in happy paths).
  page.on('dialog', (dialog) => {
    void dialog.accept();
  });
  await page.goto('/');
});

test('home screen renders title + add-meal button + empty today', async ({ page }) => {
  await expect(page.locator('h1')).toHaveText('Food Log');
  await expect(page.locator('#add-meal-btn')).toBeVisible();
  // v1.6: there are two .today-empty messages on a fresh home (meals + weight).
  // Scope the meal empty-state to the first card so the selector is unambiguous.
  await expect(page.locator('.card').first().locator('.today-empty')).toContainText(
    'No meals yet today'
  );
});

test('add-meal button opens the meal-entry sheet with chip-row + textarea + add-photo', async ({
  page,
}) => {
  await page.locator('#add-meal-btn').click();
  await expect(page.locator('.sheet-panel')).toBeVisible();
  // v1.6 — chip row replaces the always-visible date+time inputs.
  for (const id of ['now', 'morning', 'midday', 'afternoon', 'evening', 'late', 'custom']) {
    await expect(page.locator(`#meal-chip-${id}`)).toBeVisible();
  }
  // Now chip is default-selected.
  await expect(page.locator('#meal-chip-now')).toHaveClass(/chip-selected/);
  // Custom-mode inputs exist but their row is hidden until Custom is tapped.
  await expect(page.locator('#sheet-custom-row')).not.toHaveClass(/visible/);
  await expect(page.locator('#sheet-desc')).toBeVisible();
  await expect(page.locator('#sheet-add-photo')).toBeVisible();
  // v1.7.1 — photo input accepts gallery (no `capture`) + multi-select.
  const photoInput = page.locator('#sheet-photo-input');
  await expect(photoInput).toHaveAttribute('accept', 'image/*');
  await expect(photoInput).toHaveAttribute('multiple', 'true');
  await expect(photoInput).not.toHaveAttribute('capture', 'environment');
});

test('tapping a chip selects it, tapping Custom expands the date+time inputs', async ({ page }) => {
  await page.locator('#add-meal-btn').click();
  await page.locator('#meal-chip-morning').click();
  await expect(page.locator('#meal-chip-morning')).toHaveClass(/chip-selected/);
  await expect(page.locator('#meal-chip-now')).not.toHaveClass(/chip-selected/);
  // The visible chip-display label updates.
  await expect(page.locator('#sheet-chip-display')).toHaveText('Morning');
  // Custom inputs still hidden.
  await expect(page.locator('#sheet-custom-row')).not.toHaveClass(/visible/);
  // Tap Custom — inputs appear.
  await page.locator('#meal-chip-custom').click();
  await expect(page.locator('#sheet-custom-row')).toHaveClass(/visible/);
  await expect(page.locator('#sheet-date')).toBeVisible();
  await expect(page.locator('#sheet-time')).toBeVisible();
});

test('saving a meal with the Morning chip lands eaten_at at 09:00 today', async ({ page }) => {
  await page.locator('#add-meal-btn').click();
  await page.locator('#meal-chip-morning').click();
  await page.locator('#sheet-desc').fill('eggs');
  await page.locator('#sheet-save').click();
  const firstCard = page.locator('.meal-list .meal-card').first();
  await expect(firstCard).toBeVisible({ timeout: 5000 });
  await expect(firstCard.locator('.meal-card-time')).toHaveText('09:00');
});

test('editing a 09:15 meal pre-selects the Morning chip', async ({ page }) => {
  // Seed via the API directly so we control eaten_at down to the minute.
  const today = new Date();
  const seed = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 9, 15, 0);
  await page.evaluate(async (iso) => {
    const res = await fetch('https://hpiyvnfhoqnnnotrmwaz.supabase.co/rest/v1/meals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eaten_at: iso, description: 'pre-seeded breakfast' }),
    });
    return res.status;
  }, seed.toISOString());
  await page.reload();
  await page.locator('.meal-list .meal-card').first().click();
  await page.locator('.lightbox-edit').click();
  await expect(page.locator('#meal-chip-morning')).toHaveClass(/chip-selected/);
  await expect(page.locator('#sheet-custom-row')).not.toHaveClass(/visible/);
});

test('editing a meal with an off-hours time lands on Custom mode', async ({ page }) => {
  // 02:30 today — outside any chip's ±90min window.
  const today = new Date();
  const seed = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 2, 30, 0);
  await page.evaluate(async (iso) => {
    await fetch('https://hpiyvnfhoqnnnotrmwaz.supabase.co/rest/v1/meals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eaten_at: iso, description: '2am snack' }),
    });
  }, seed.toISOString());
  await page.reload();
  await page.locator('.meal-list .meal-card').first().click();
  await page.locator('.lightbox-edit').click();
  await expect(page.locator('#meal-chip-custom')).toHaveClass(/chip-selected/);
  await expect(page.locator('#sheet-custom-row')).toHaveClass(/visible/);
  await expect(page.locator('#sheet-time')).toHaveValue('02:30');
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

test('Custom-mode date + time fields default to now and persist on save', async ({ page }) => {
  await page.locator('#add-meal-btn').click();
  await page.locator('#meal-chip-custom').click();
  const date = page.locator('#sheet-date');
  const time = page.locator('#sheet-time');
  const today = new Date();
  const yyyy = today.getFullYear().toString();
  const mo = (today.getMonth() + 1).toString().padStart(2, '0');
  const da = today.getDate().toString().padStart(2, '0');
  await expect(date).toHaveValue(`${yyyy}-${mo}-${da}`);
  expect(await time.inputValue()).toMatch(/^\d{2}:\d{2}$/);

  // Set a precise time and save — Custom path should write that exact time.
  await time.fill('08:30');
  await page.locator('#sheet-desc').fill('breakfast');
  await page.locator('#sheet-save').click();
  const firstCard = page.locator('.meal-list .meal-card').first();
  await expect(firstCard).toBeVisible({ timeout: 5000 });
  await expect(firstCard.locator('.meal-card-time')).toHaveText('08:30');
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
  expect(body).toContain('food-log-v1-8');
  expect(body).toContain('./dist/app.js');
  expect(body).toContain('./manifest.webmanifest');
});

// ─── v1.6 weight surface ────────────────────────────────────────────────────

test('home screen shows the ⚖ Weight + 📝 Note sibling buttons next to ➕ Meal', async ({
  page,
}) => {
  await expect(page.locator('#add-meal-btn')).toBeVisible();
  await expect(page.locator('#add-weight-btn')).toBeVisible();
  // v1.8: Notes is always-on (sibling to meals/weight). Notes captures
  // app-meta thoughts she was previously misrouting into meals.description.
  await expect(page.locator('#add-note-btn')).toBeVisible();
  // Cooked button is hidden by default and only appears once she has at least
  // one cook session in history (2026-05-27 audit: avoid surfacing an unused
  // affordance during the data-gathering phase).
  await expect(page.locator('#add-cook-btn')).toHaveCount(0);
  // Three always-on pills (meal + weight + note); cook is conditional.
  const siblings = page.locator('.quick-actions .quick-action');
  await expect(siblings).toHaveCount(3);
});

test('Cooked button appears once a cook session exists', async ({ page }) => {
  // Seed a cook session through the mocked API, then reload to re-fetch.
  await page.evaluate(async () => {
    await fetch('https://hpiyvnfhoqnnnotrmwaz.supabase.co/rest/v1/cook_sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cooked_at: new Date().toISOString(),
        description: 'roast chicken',
        total_portions: 4,
        notes: null,
      }),
    });
  });
  await page.reload();
  await expect(page.locator('#add-cook-btn')).toBeVisible();
  // 4 pills now: meal + cook + weight + note.
  const siblings = page.locator('.quick-actions .quick-action');
  await expect(siblings).toHaveCount(4);
});

test('Weight button opens the weight sheet with chip row + kg input + notes', async ({ page }) => {
  await page.locator('#add-weight-btn').click();
  await expect(page.locator('.sheet-panel')).toBeVisible();
  for (const id of ['now', 'morning', 'midday', 'afternoon', 'evening', 'late', 'custom']) {
    await expect(page.locator(`#weight-chip-${id}`)).toBeVisible();
  }
  await expect(page.locator('#weight-chip-now')).toHaveClass(/chip-selected/);
  await expect(page.locator('#sheet-weight-input')).toBeVisible();
  await expect(page.locator('#sheet-weight-notes')).toBeVisible();
});

test('Weight save is disabled when empty, enabled with a valid decimal', async ({ page }) => {
  await page.locator('#add-weight-btn').click();
  const save = page.locator('#sheet-weight-save');
  await expect(save).toBeDisabled();
  await page.locator('#sheet-weight-input').fill('64.3');
  await expect(save).toBeEnabled();
});

test('Weight save is disabled when input is invalid (zero / out of range)', async ({ page }) => {
  await page.locator('#add-weight-btn').click();
  const save = page.locator('#sheet-weight-save');
  // Zero — not allowed (parse bound > 0).
  await page.locator('#sheet-weight-input').fill('0');
  await expect(save).toBeDisabled();
  // v1.7: range expanded to <=1000 to allow lb entries (200lb fine, but 999lb is too).
  // Wildly out of range.
  await page.locator('#sheet-weight-input').fill('9999');
  await expect(save).toBeDisabled();
  // Valid.
  await page.locator('#sheet-weight-input').fill('64.3');
  await expect(save).toBeEnabled();
});

test('saving a weight shows it in the Weight section on home', async ({ page }) => {
  await page.locator('#add-weight-btn').click();
  await page.locator('#sheet-weight-input').fill('64.3');
  await page.locator('#sheet-weight-save').click();
  // Sheet closes, row appears.
  await expect(page.locator('.sheet-panel')).toHaveCount(0);
  const firstRow = page.locator('.weight-list .weight-row').first();
  await expect(firstRow).toBeVisible({ timeout: 5000 });
  await expect(firstRow.locator('.weight-row-kg')).toHaveText('64.3 kg');
  await expect(page.locator('.toast')).toContainText(/saved/);
});

test('next weight entry pre-fills with the last saved value', async ({ page }) => {
  // First entry.
  await page.locator('#add-weight-btn').click();
  await page.locator('#sheet-weight-input').fill('64.3');
  await page.locator('#sheet-weight-save').click();
  await expect(page.locator('.weight-list .weight-row').first()).toBeVisible({ timeout: 5000 });

  // Second open — input pre-filled with the prior value.
  await page.locator('#add-weight-btn').click();
  await expect(page.locator('#sheet-weight-input')).toHaveValue('64.3');
});

test('weight notes save and surface on the card', async ({ page }) => {
  await page.locator('#add-weight-btn').click();
  await page.locator('#sheet-weight-input').fill('64.0');
  await page.locator('#sheet-weight-notes').fill('post-workout, dehydrated');
  await page.locator('#sheet-weight-save').click();
  const firstRow = page.locator('.weight-list .weight-row').first();
  await expect(firstRow).toBeVisible({ timeout: 5000 });
  await expect(firstRow.locator('.weight-row-notes')).toContainText('post-workout');
});

test('Weight section shows an empty-state hint when no entries exist', async ({ page }) => {
  await expect(page.locator('.weight-section .today-empty')).toContainText(/No weight entries/i);
});

// ─── v1.8 notes surface ─────────────────────────────────────────────────────

test('Note button opens the note sheet with a focused textarea', async ({ page }) => {
  await page.locator('#add-note-btn').click();
  await expect(page.locator('.sheet-panel')).toBeVisible();
  await expect(page.locator('#sheet-note-text')).toBeVisible();
  // Save disabled until she writes something.
  await expect(page.locator('#sheet-note-save')).toBeDisabled();
});

test('Note save enables once any text is typed', async ({ page }) => {
  await page.locator('#add-note-btn').click();
  await page.locator('#sheet-note-text').fill('maybe we should make this just for claud');
  await expect(page.locator('#sheet-note-save')).toBeEnabled();
});

test('saving a note shows it in the Notes section on home', async ({ page }) => {
  await page.locator('#add-note-btn').click();
  await page.locator('#sheet-note-text').fill('not reporting food, working on the interface');
  await page.locator('#sheet-note-save').click();

  // Sheet closes, row appears in notes list.
  await expect(page.locator('.sheet-panel')).toHaveCount(0);
  const firstRow = page.locator('.notes-section .note-row').first();
  await expect(firstRow).toBeVisible({ timeout: 5000 });
  await expect(firstRow.locator('.note-row-text')).toContainText('working on the interface');
  await expect(page.locator('.toast')).toContainText(/saved/);
});

test('tapping a note row opens a lightbox with the full text + close', async ({ page }) => {
  await page.locator('#add-note-btn').click();
  await page
    .locator('#sheet-note-text')
    .fill(
      'a long thought that should show in full inside the lightbox rather than truncated preview'
    );
  await page.locator('#sheet-note-save').click();
  await page.locator('.notes-section .note-row').first().click();
  await expect(page.locator('.lightbox')).toBeVisible();
  await expect(page.locator('.lightbox-desc')).toContainText('a long thought');
  await expect(page.locator('.lightbox-close')).toBeVisible();
  await page.locator('.lightbox-close').click();
  await expect(page.locator('.lightbox')).toHaveCount(0);
});

test('Notes section shows an empty-state hint when no notes exist', async ({ page }) => {
  await expect(page.locator('.notes-section .today-empty')).toContainText(/No notes yet/i);
});

test('Notes survive a page refresh (Supabase round-trip, not local-only)', async ({ page }) => {
  await page.locator('#add-note-btn').click();
  await page.locator('#sheet-note-text').fill('persistent thought');
  await page.locator('#sheet-note-save').click();
  // Wait for the saved row before reload to ensure POST hit the mocked API.
  await expect(page.locator('.notes-section .note-row').first()).toBeVisible({ timeout: 5000 });

  await page.reload();
  const firstRow = page.locator('.notes-section .note-row').first();
  await expect(firstRow).toBeVisible({ timeout: 5000 });
  await expect(firstRow.locator('.note-row-text')).toContainText('persistent thought');
});
