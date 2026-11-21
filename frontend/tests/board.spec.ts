import { expect, test, type Page } from '@playwright/test';

const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'tablet', width: 1024, height: 800 },
  { name: 'desktop', width: 1440, height: 900 },
];

/** Load the board with the guide dismissed and no remembered drawer state. */
async function openBoard(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem('gridevac-guide-seen', '1');
      // Clear remembered board state once per context, so a test can reload
      // to prove the drawer sticks without the reset wiping it.
      if (!window.sessionStorage.getItem('gridevac-test-init')) {
        window.sessionStorage.setItem('gridevac-test-init', '1');
        window.localStorage.removeItem('gridevac-board-audit');
        window.localStorage.removeItem('gridevac-board-briefing');
      }
    } catch { /* private mode */ }
  });
  await page.goto('/');
  await expect(page.getByRole('slider', { name: /scenario water level/i })).toBeVisible();
}

test.describe('board layout', () => {
  for (const viewport of VIEWPORTS) {
    test(`${viewport.name}: nothing scrolls sideways`, async ({ page }) => {
      await openBoard(page, viewport.width, viewport.height);
      const overshoot = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overshoot).toBeLessThanOrEqual(0);
    });
  }

  test('the map keeps the largest share of a wide board', async ({ page }) => {
    await openBoard(page, 1440, 900);
    const widths = await page.evaluate(() => {
      const box = (selector: string) => document.querySelector(selector)?.getBoundingClientRect().width ?? 0;
      return { map: box('.pane-map'), directive: box('.pane-directive'), scenario: box('.pane-scenario') };
    });
    expect(widths.map).toBeGreaterThan(widths.directive);
    expect(widths.map).toBeGreaterThan(widths.scenario);
  });

  test('the audit drawer opens to a usable height and closes', async ({ page }) => {
    await openBoard(page, 1440, 900);
    const drawer = page.locator('.drawer');
    await expect(drawer).toHaveAttribute('data-open', 'false');

    await page.getByRole('button', { name: /route audit/i }).click();
    await expect(drawer).toHaveAttribute('data-open', 'true');
    await expect(page.locator('#audit-body')).toBeVisible();

    const openHeight = await drawer.evaluate((element) => element.getBoundingClientRect().height);
    expect(openHeight).toBeGreaterThan(200);

    await page.getByRole('button', { name: /route audit/i }).click();
    await expect(drawer).toHaveAttribute('data-open', 'false');
    const closedHeight = await drawer.evaluate((element) => element.getBoundingClientRect().height);
    expect(closedHeight).toBeLessThan(80);
  });

  test('the briefing sheet opens beside the map below 1360px', async ({ page }) => {
    await openBoard(page, 1024, 800);
    const sheet = page.locator('.pane-directive');
    await expect(sheet).toBeHidden();

    await page.locator('.pane-toggle').click();
    await expect(sheet).toBeVisible();
    const left = await sheet.evaluate((element) => element.getBoundingClientRect().left);
    expect(left).toBeGreaterThanOrEqual(0);

    await page.getByRole('button', { name: /close the briefing/i }).click();
    await expect(sheet).toBeHidden();
  });
});

test.describe('scenario control', () => {
  test('dragging the staff raises the water level', async ({ page }) => {
    await openBoard(page, 1440, 900);
    const staff = page.getByRole('slider', { name: /scenario water level/i });
    const before = Number(await staff.getAttribute('aria-valuenow'));

    const box = await staff.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height - 6);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height * 0.3, { steps: 8 });
    await page.mouse.up();

    const after = Number(await staff.getAttribute('aria-valuenow'));
    expect(after).toBeGreaterThan(before + 2);
    await expect(page.locator('.rail-gauge-value')).not.toHaveText('1.0m');
  });

  test('the staff lies flat on a phone and still drags', async ({ page }) => {
    await openBoard(page, 390, 844);
    const staff = page.getByRole('slider', { name: /scenario water level/i });
    await expect(staff).toHaveAttribute('aria-orientation', 'horizontal');

    const box = await staff.boundingBox();
    const before = Number(await staff.getAttribute('aria-valuenow'));
    await page.mouse.move(box!.x + 4, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width * 0.7, box!.y + box!.height / 2, { steps: 6 });
    await page.mouse.up();

    expect(Number(await staff.getAttribute('aria-valuenow'))).toBeGreaterThan(before + 2);
  });

  test('arrow keys step the water level', async ({ page }) => {
    await openBoard(page, 1440, 900);
    const staff = page.getByRole('slider', { name: /scenario water level/i });
    await staff.focus();
    const before = Number(await staff.getAttribute('aria-valuenow'));
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    await expect(staff).toHaveAttribute('aria-valuenow', String(Math.round((before + 0.4) * 10) / 10));
  });
});

test.describe('accessibility wiring', () => {
  test('audit tabs move with the arrow keys', async ({ page }) => {
    await openBoard(page, 1440, 900);
    const tabs = page.locator('.drawer-tabs [role="tab"]');
    await tabs.first().click();
    await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowRight');
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(tabs.nth(1)).toBeFocused();
    await page.keyboard.press('End');
    await expect(tabs.last()).toHaveAttribute('aria-selected', 'true');
  });

  test('Escape on the audit drawer hands focus back to its toggle', async ({ page }) => {
    await openBoard(page, 1440, 900);
    const drawer = page.locator('.drawer');
    const toggle = page.getByRole('button', { name: /route audit/i });

    await toggle.click();
    await expect(drawer).toHaveAttribute('data-open', 'true');
    await expect(page.locator('.drawer-tabs [role="tab"]').first()).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(drawer).toHaveAttribute('data-open', 'false');
    await expect(toggle).toBeFocused();
  });

  test('closing the briefing hands focus back to its toggle', async ({ page }) => {
    await openBoard(page, 1024, 800);
    const toggle = page.locator('.pane-toggle');
    const sheet = page.locator('.pane-directive');

    await toggle.click();
    await expect(sheet).toBeVisible();
    await page.getByRole('button', { name: /close the briefing/i }).click();
    await expect(sheet).toBeHidden();
    await expect(toggle).toBeFocused();

    await toggle.click();
    await expect(sheet).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await expect(toggle).toBeFocused();
  });

  test('a remembered drawer stays open across reloads', async ({ page }) => {
    await openBoard(page, 1440, 900);
    await page.getByRole('button', { name: /route audit/i }).click();
    await expect(page.locator('.drawer')).toHaveAttribute('data-open', 'true');

    await page.reload();
    await expect(page.locator('.drawer')).toHaveAttribute('data-open', 'true');
  });
});
