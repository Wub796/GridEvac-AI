import { expect, test } from '@playwright/test';

/**
 * Runs against the live deployment, not a local server: the board still renders
 * and solves routes when it loses the API, so a stale API origin or a CORS
 * regression only shows up as the topbar quietly reading "Local solver".
 *
 * Usage: npm run test:deployed
 */
const SITE = process.env.DEPLOYED_URL ?? 'https://grid-evac-ai.vercel.app';
const API = process.env.DEPLOYED_API_URL ?? 'https://grid-evac-ai-api.vercel.app';

test('the deployed board solves through the deployed API', async ({ page, request }) => {
  const cityResponse = await request.get(`${API}/api/city`);
  expect(cityResponse.status(), 'GET /api/city').toBe(200);
  const city = await cityResponse.json();
  const exits = new Set<number>(city.safe_exits ?? []);
  // Exits are endpoints, so an interior junction makes the better origin.
  const origin = city.nodes.find((node: any) => !exits.has(node.id) && !node.elevated)?.id;

  const route = await request.post(`${API}/api/calculate-route`, {
    data: { flood_level: 0, failed_substations: [], origin_node: origin, travel_mode: 'vehicle' },
  });
  expect(route.status(), 'POST /api/calculate-route').toBe(200);
  expect((await route.json()).success, 'route solved').toBe(true);

  await page.goto(SITE, { waitUntil: 'domcontentloaded' });
  // The page renders either way, so this label is the only proof it has the API.
  await expect(page.locator('.topbar-status')).toContainText('Routing API', { timeout: 45_000 });
});
