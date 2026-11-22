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

test.describe('touch targets', () => {
  const MIN_TARGET_PX = 44;
  const CONTROL_SELECTOR = [
    'button',
    'input:not([type="hidden"])',
    'select',
    'textarea',
    'a[href]',
    '[role="button"]',
    '[role="tab"]',
    '[role="slider"]',
    '[role="switch"]',
    '[role="checkbox"]',
    '[role="radio"]',
    'label:has(input)',
  ].join(', ');

  /**
   * Controls whose pointer area is narrower or shorter than the minimum. The
   * border box is not the target: the water staff draws 26px wide and widens
   * itself with ::before, so probe the 44px box around each center instead.
   * Cesium's injected credit links are excluded; the rest of the page is ours.
   */
  async function undersizedControls(page: Page): Promise<string[]> {
    return page.evaluate(
      ({ selector, min }) => {
        const failures: string[] = [];
        const seen = new Set<Element>();
        for (const element of Array.from(document.querySelectorAll(selector))) {
          if (seen.has(element)) continue;
          seen.add(element);
          if (element.closest('.sr-only, .cesium-widget-credits')) continue;
          if ((element as HTMLButtonElement).disabled) continue;
          const style = getComputedStyle(element);
          if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
          const rect = element.getBoundingClientRect();
          if (rect.width < 1 || rect.height < 1) continue;
          const cx = rect.left + rect.width / 2;
          const cy = rect.top + rect.height / 2;
          if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) continue;

          // Clamp to the viewport: a control flush with an edge still owns the
          // part of its target that is on screen.
          const reaches = (x: number, y: number) => {
            const hit = document.elementFromPoint(
              Math.min(Math.max(x, 0), window.innerWidth - 1),
              Math.min(Math.max(y, 0), window.innerHeight - 1),
            );
            return !!hit && (hit === element || element.contains(hit) || hit.closest('label')?.contains(element) === true);
          };
          // Sample just inside the 44px boundary: an exactly-44px target ends
          // on the same pixel as the probe.
          const half = min / 2 - 0.5;
          const wide = rect.width >= min || (reaches(cx - half, cy) && reaches(cx + half, cy));
          const tall = rect.height >= min || (reaches(cx, cy - half) && reaches(cx, cy + half));
          if (wide && tall) continue;

          const name = (element.getAttribute('aria-label') ?? element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
          const classes = (element.getAttribute('class') ?? '').trim().replace(/\s+/g, '.');
          failures.push(`${element.tagName.toLowerCase()}${classes ? `.${classes}` : ''} "${name}" ${Math.round(rect.width)}x${Math.round(rect.height)}`);
        }
        return failures;
      },
      { selector: CONTROL_SELECTOR, min: MIN_TARGET_PX },
    );
  }

  /** Switch tabs and give the panel a frame to lay out. */
  async function openTab(page: Page, name: RegExp) {
    await page.getByRole('tab', { name }).first().click();
    await expect(page.getByRole('tab', { name }).first()).toHaveAttribute('aria-selected', 'true');
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  }

  test('desktop: every visible control in each panel offers a 44px target', async ({ page }) => {
    await openBoard(page, 1440, 900);
    expect(await undersizedControls(page)).toEqual([]);

    for (const tab of [/^route$/i, /^analysis$/i, /^layers$/i]) {
      await openTab(page, tab);
      expect(await undersizedControls(page), `control panel ${tab}`).toEqual([]);
    }

    await page.getByRole('button', { name: /route audit/i }).click();
    const auditTabs = page.locator('.drawer-tabs [role="tab"]');
    const auditTabCount = await auditTabs.count();
    // Tabs that need server data are absent when a build runs the local solver
    // (CI has no API origin), so walk whichever tabs this build renders.
    expect(auditTabCount).toBeGreaterThan(0);
    for (let index = 0; index < auditTabCount; index += 1) {
      const tab = auditTabs.nth(index);
      await tab.click();
      await expect(tab).toHaveAttribute('aria-selected', 'true');
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      expect(await undersizedControls(page), `audit tab ${index}`).toEqual([]);
    }
  });

  test('tablet: the briefing sheet and its shelter buttons offer 44px targets', async ({ page }) => {
    await openBoard(page, 1024, 800);
    const sheet = page.locator('.pane-directive');
    await expect(sheet).toBeHidden();

    await page.locator('.pane-toggle').click();
    await expect(sheet).toBeVisible();
    expect(await undersizedControls(page), 'briefing sheet top').toEqual([]);

    // The shelter cards sit below the fold in the sheet's own scroll area.
    const shelters = page.locator('.sh-list');
    await expect(shelters).toBeVisible();
    await shelters.scrollIntoViewIfNeeded();
    const shelterButtons = page.locator('.sh-list button');
    await expect(shelterButtons.first()).toBeVisible();
    // The sweep only measures controls whose center is on screen, so prove at
    // least one shelter button is in view before trusting the empty failure list.
    const onScreen = await shelterButtons.evaluateAll((buttons) => buttons.filter((button) => {
      const rect = button.getBoundingClientRect();
      const cy = rect.top + rect.height / 2;
      return cy >= 0 && cy <= window.innerHeight;
    }).length);
    expect(onScreen).toBeGreaterThan(0);
    expect(await undersizedControls(page), 'briefing shelters').toEqual([]);

    await page.getByRole('button', { name: /close the briefing/i }).click();
    await expect(sheet).toBeHidden();
  });

  test('offline: the local-solver status control offers a 44px target', async ({ page }) => {
    // CI builds have no API origin; blocking the API here reaches the same
    // "Local solver" retry button the CI run renders.
    await page.route('**/api/**', (route) => route.abort());
    await openBoard(page, 1440, 900);
    await expect(page.locator('button.connection--offline')).toBeVisible({ timeout: 25_000 });
    expect(await undersizedControls(page)).toEqual([]);
  });

  test('phone: every visible control offers a 44px target', async ({ page }) => {
    await openBoard(page, 390, 844);
    expect(await undersizedControls(page)).toEqual([]);
  });
});
