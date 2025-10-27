import { test, expect } from '@playwright/test';

// ⚠️ Роут больше не нужен — мы глушим в index.html по ?e2e=1
// Оставим только добавление класса dark и минимальные ожидания.

async function pickArea(page) {
  // единая зона, чтобы не делать fullPage на «тяжёлых» девайсах
  const area = page.locator('.player-safe').first();
  await area.waitFor({ state: 'visible', timeout: 12000 });
  return area;
}

test('Home dark – full page (iOS only snapshot)', async ({ page, browserName }) => {
  await page.addInitScript(() => document.documentElement.classList.add('dark'));
  await page.goto('/'); // baseURL уже содержит ?e2e=1
  await page.waitForLoadState('domcontentloaded');

  // На Android иногда падает по памяти при fullPage — снимем полноэкранный снапшот только на WebKit (iOS),
  // а на остальных просто проверим видимость ключевой зоны.
  const isiOS = browserName === 'webkit';
  if (isiOS) {
    await expect(page).toHaveScreenshot('home-dark.png', { fullPage: true, timeout: 30000 });
  } else {
    await expect(await pickArea(page)).toBeVisible();
  }
});

test('Track list dark – card area', async ({ page }) => {
  await page.addInitScript(() => document.documentElement.classList.add('dark'));
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');

  const area = await pickArea(page);
  await expect(area).toHaveScreenshot('tracks-dark.png', { timeout: 20000 });
});