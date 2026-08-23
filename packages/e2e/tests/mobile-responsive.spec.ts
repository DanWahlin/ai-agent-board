import { test, expect, devices, request as apiRequest, type Page } from '@playwright/test';
import { mkdirSync } from 'fs';
import path from 'path';
import { API, waitForBoard } from './helpers';

/**
 * Mobile / tablet / desktop responsive regression suite.
 *
 * Proves the touch-first horizontal Kanban rail (CSS scroll snap) and the
 * full-viewport task drawer geometry on phone portrait, phone landscape,
 * tablet, and desktop viewports. These tests FAIL under the previous
 * stacked `max-md:flex-col max-md:overflow-x-hidden` layout because the
 * rail then has no horizontal overflow (scrollWidth === clientWidth).
 */

const IPHONE_UA = devices['iPhone 13'].userAgent;
const FIXTURE_PREFIX = 'MobileFixture';
const LONG_TITLE = `${FIXTURE_PREFIX} Backlog with an intentionally very long task title that must wrap or truncate without breaking layout`;
const IN_PROGRESS_TITLE = `${FIXTURE_PREFIX} InProgress agent task`;
const REVIEW_TITLE = `${FIXTURE_PREFIX} Review task`;
const LONG_DESCRIPTION = [
  'A long markdown description used to verify the expanded task description scroller.',
  '',
  '- step one with `inline code` and a fairly long line of explanatory prose to force wrapping',
  '- step two',
  '- step three',
  '',
  'Final paragraph with more prose so the description block has real height on short landscape viewports.',
].join('\n');

const SCREENSHOT_DIR = path.resolve('test-results', 'mobile-ux');

const MOBILE_VIEWPORTS = [
  { name: 'portrait-375x812', width: 375, height: 812 },
  { name: 'portrait-430x932', width: 430, height: 932 },
  { name: 'landscape-812x375', width: 812, height: 375 },
  { name: 'landscape-932x430', width: 932, height: 430 },
] as const;

const seededIds: string[] = [];

async function seedFixture(requestCtx: any) {
  const existing = await (await requestCtx.get(`${API}/api/tasks`)).json();
  const byTitle = new Map<string, any>(existing.map((t: any) => [t.title, t]));

  if (!byTitle.has(LONG_TITLE)) {
    const res = await requestCtx.post(`${API}/api/tasks`, {
      data: { title: LONG_TITLE, description: 'Backlog fixture', columnId: 'backlog' },
    });
    seededIds.push((await res.json()).id);
  }
  if (!byTitle.has(IN_PROGRESS_TITLE)) {
    const res = await requestCtx.post(`${API}/api/tasks`, {
      data: { title: IN_PROGRESS_TITLE, description: LONG_DESCRIPTION, columnId: 'in-progress' },
    });
    seededIds.push((await res.json()).id);
  }
  if (!byTitle.has(REVIEW_TITLE)) {
    const res = await requestCtx.post(`${API}/api/tasks`, {
      data: { title: REVIEW_TITLE, description: 'Review fixture', columnId: 'in-progress' },
    });
    const created = await res.json();
    seededIds.push(created.id);
    await requestCtx.patch(`${API}/api/tasks/${created.id}`, { data: { columnId: 'review' } });
  }
}

test.afterAll(async () => {
  const ctx = await apiRequest.newContext();
  for (const id of seededIds.splice(0)) {
    await ctx.delete(`${API}/api/tasks/${id}`).catch(() => {});
  }
  await ctx.dispose();
});

async function railMetrics(page: Page) {
  return page.evaluate(() => {
    const rail = document.querySelector('[data-board-rail]') as HTMLElement | null;
    return {
      exists: !!rail,
      scrollWidth: rail?.scrollWidth ?? 0,
      clientWidth: rail?.clientWidth ?? 0,
      snapType: rail ? getComputedStyle(rail).scrollSnapType : '',
      docScrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      bodyScrollWidth: document.body.scrollWidth,
    };
  });
}

async function openTaskDrawer(page: Page, title: string) {
  const heading = page.getByRole('heading', { name: title });
  await heading.scrollIntoViewIfNeeded();
  await heading.click();
  await expect(page.locator('#agent-panel')).toBeVisible({ timeout: 5_000 });
}

for (const vp of MOBILE_VIEWPORTS) {
  test.describe(`Mobile ${vp.name}`, () => {
    test.use({
      viewport: { width: vp.width, height: vp.height },
      userAgent: IPHONE_UA,
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 3,
    });

    test.beforeEach(async ({ page, request }) => {
      await seedFixture(request);
      await page.goto('/');
      await waitForBoard(page);
    });

    test('board is a horizontal snap rail, not a vertical stack', async ({ page }) => {
      const m = await railMetrics(page);
      expect(m.exists).toBe(true);
      // Horizontal swipe geometry: the rail overflows horizontally...
      expect(m.scrollWidth).toBeGreaterThan(m.clientWidth);
      // ...with CSS scroll snap on the x axis...
      expect(m.snapType).toContain('x');
      // ...and no document-level horizontal overflow outside the rail.
      expect(m.docScrollWidth).toBeLessThanOrEqual(m.innerWidth + 1);
      expect(m.bodyScrollWidth).toBeLessThanOrEqual(m.innerWidth + 1);

      // Each column fits within the viewport width (next column peeks in).
      const wrappers = page.locator('[data-board-rail] [data-column]');
      await expect(wrappers).toHaveCount(4);
      for (let i = 0; i < 4; i++) {
        const box = await wrappers.nth(i).boundingBox();
        expect(box, `column ${i} has a box`).not.toBeNull();
        expect(box!.width).toBeLessThanOrEqual(vp.width);
        expect(box!.width).toBeGreaterThan(0);
      }
    });

    test('all four columns are reachable via the position affordance', async ({ page }) => {
      const nav = page.locator('nav[aria-label="Board columns"]');
      await expect(nav).toBeVisible();
      const dots = nav.locator('button');
      await expect(dots).toHaveCount(4);
      for (let i = 0; i < 4; i++) {
        const target = await dots.nth(i).boundingBox();
        expect(target!.width).toBeGreaterThanOrEqual(44);
        expect(target!.height).toBeGreaterThanOrEqual(44);
      }

      const headings = ['Backlog', 'In Progress', 'Review', 'Done'];
      for (let i = 3; i >= 0; i--) {
        await dots.nth(i).click();
        await expect(page.getByRole('heading', { name: headings[i], exact: true }))
          .toBeInViewport({ timeout: 5_000 });
      }
      // Position label reflects the first column after navigating back.
      await expect(nav.getByText('1 of 4', { exact: true })).toBeVisible();
      // aria-current marks the active dot for assistive tech.
      await expect(nav.locator('button[aria-current="true"]')).toHaveCount(1);
    });

    test('empty column shows its empty state on the rail', async ({ page }) => {
      // Filter to the fixture prefix so the Done column is deterministically empty.
      await page.getByRole('button', { name: 'Open menu' }).click();
      // Two search inputs exist (hidden desktop + mobile menu) — use the visible one.
      await page.locator('input[aria-label="Search tasks"]:visible').fill(FIXTURE_PREFIX);
      await page.getByRole('button', { name: 'Close menu' }).click();

      const nav = page.locator('nav[aria-label="Board columns"]');
      await nav.locator('button').nth(3).click();
      await expect(page.getByRole('heading', { name: 'Done', exact: true })).toBeInViewport();
      await expect(page.getByText('Reviewed tasks', { exact: true })).toBeVisible();
    });

    test('cards keep native pan gestures (deliberate drag only)', async ({ page }) => {
      const card = page
        .locator('[data-column="backlog"] .group')
        .filter({ has: page.getByRole('heading', { name: LONG_TITLE }) });
      await card.scrollIntoViewIfNeeded();
      const touchAction = await card.evaluate((el) => getComputedStyle(el).touchAction);
      // touch-action: manipulation preserves pan-x/pan-y scrolling; drags
      // require the TouchSensor press-and-hold activation.
      expect(touchAction).toBe('manipulation');
    });

    test('header keeps compact mobile controls without overlap', async ({ page }) => {
      const hamburger = page.getByRole('button', { name: 'Open menu' });
      await expect(hamburger).toBeVisible();
      // Desktop-only controls must not appear at phone widths (incl. landscape).
      await expect(page.getByRole('button', { name: 'New Task' })).toBeHidden();

      const title = page.getByRole('heading', { name: 'AI Agent Board' });
      const titleBox = await title.boundingBox();
      const burgerBox = await hamburger.boundingBox();
      expect(titleBox).not.toBeNull();
      expect(burgerBox).not.toBeNull();
      // Title never overlaps the actions cluster.
      expect(titleBox!.x + titleBox!.width).toBeLessThanOrEqual(burgerBox!.x + 1);
      // Hamburger is a >=44px touch target.
      expect(burgerBox!.width).toBeGreaterThanOrEqual(44);
      expect(burgerBox!.height).toBeGreaterThanOrEqual(44);
    });

    test('task drawer is a full-viewport sheet with visible composer', async ({ page }) => {
      await openTaskDrawer(page, IN_PROGRESS_TITLE);
      const panel = page.locator('#agent-panel');

      const box = await panel.boundingBox();
      expect(box).not.toBeNull();
      // Full sheet: fills the viewport, never exceeds it.
      expect(Math.round(box!.width)).toBeGreaterThanOrEqual(vp.width - 1);
      expect(box!.x).toBeGreaterThanOrEqual(-1);
      expect(box!.y).toBeGreaterThanOrEqual(-1);
      expect(box!.y + box!.height).toBeLessThanOrEqual(vp.height + 1);

      // Composer stays visible and inside the viewport.
      const composer = page.getByPlaceholder('Send a message to the agent...');
      await expect(composer).toBeInViewport();
      const composerBox = await composer.boundingBox();
      expect(composerBox!.y + composerBox!.height).toBeLessThanOrEqual(vp.height + 1);
      expect(composerBox!.height).toBeGreaterThanOrEqual(40);

      // Tabs/action row scrolls horizontally instead of clipping.
      const tabs = page.locator('[data-panel-tabs]');
      const overflowX = await tabs.evaluate((el) => getComputedStyle(el).overflowX);
      expect(['auto', 'scroll']).toContain(overflowX);
      for (const tab of ['Events', 'Terminal']) {
        const button = page.getByRole('button', { name: tab });
        await expect(button).toBeInViewport();
        const target = await button.boundingBox();
        expect(target!.height).toBeGreaterThanOrEqual(44);
      }

      // Events content area exists between header and composer.
      await expect(page.getByText('No agent activity yet')).toBeVisible();
    });

    test('expanded description and tab switches never hide the composer', async ({ page }) => {
      await openTaskDrawer(page, IN_PROGRESS_TITLE);
      const composer = page.getByPlaceholder('Send a message to the agent...');

      // Expand the long task description — composer must remain visible.
      await page.getByRole('button', { name: /Task Description/ }).click();
      await expect(composer).toBeInViewport();

      // Terminal tab.
      await page.getByRole('button', { name: 'Terminal' }).click();
      await expect(composer).toBeInViewport();

      // Actions tab.
      await page.getByRole('button', { name: /^Actions/ }).click();
      await expect(composer).toBeInViewport();
    });

    test('review task drawer shows Summary tab within the viewport', async ({ page }) => {
      await openTaskDrawer(page, REVIEW_TITLE);
      const summaryTab = page.getByRole('button', { name: 'Summary', exact: true });
      await expect(summaryTab).toBeInViewport();
      await expect(page.getByText('No summary was provided for this task.')).toBeInViewport();
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${vp.name}-drawer-summary.png`) });
    });

    test('capture board + drawer screenshots', async ({ page }) => {
      mkdirSync(SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${vp.name}-board.png`) });

      // Second column in view for the populated-board shot.
      await page.locator('nav[aria-label="Board columns"] button').nth(1).click();
      await expect(page.getByRole('heading', { name: 'In Progress', exact: true })).toBeInViewport();
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${vp.name}-board-in-progress.png`) });

      await openTaskDrawer(page, IN_PROGRESS_TITLE);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${vp.name}-drawer-events.png`) });
      await page.getByRole('button', { name: 'Terminal' }).click();
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${vp.name}-drawer-terminal.png`) });
    });
  });
}

test.describe('Tablet portrait 768x1024', () => {
  test.use({
    viewport: { width: 768, height: 1024 },
    userAgent: IPHONE_UA,
    isMobile: true,
    hasTouch: true,
  });

  test.beforeEach(async ({ page, request }) => {
    await seedFixture(request);
    await page.goto('/');
    await waitForBoard(page);
  });

  test('keeps the swipeable rail with compact fixed columns', async ({ page }) => {
    const m = await railMetrics(page);
    expect(m.scrollWidth).toBeGreaterThan(m.clientWidth);
    expect(m.snapType).toContain('x');
    // Compact fixed column width (sm:w-72 = 288px) — more than one column visible.
    const first = await page.locator('[data-board-rail] [data-column]').first().boundingBox();
    expect(first!.width).toBeLessThanOrEqual(320);
    await expect(page.getByRole('button', { name: 'Open menu' })).toBeVisible();
    await expect(page.locator('nav[aria-label="Board columns"]')).toBeVisible();
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'tablet-768x1024-board.png') });
  });
});

test.describe('Tablet landscape 1024x768', () => {
  test.use({ viewport: { width: 1024, height: 768 }, hasTouch: true });

  test.beforeEach(async ({ page, request }) => {
    await seedFixture(request);
    await page.goto('/');
    await waitForBoard(page);
  });

  test('shows desktop controls and side drawer', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'New Task' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open menu' })).toBeHidden();
    await expect(page.locator('nav[aria-label="Board columns"]')).toBeHidden();

    await openTaskDrawer(page, IN_PROGRESS_TITLE);
    const box = await page.locator('#agent-panel').boundingBox();
    // Right-side drawer, responsive width capped sensibly (not a full sheet).
    expect(box!.width).toBeLessThanOrEqual(480);
    expect(box!.width).toBeLessThan(1024);
    expect(Math.round(box!.x + box!.width)).toBeGreaterThanOrEqual(1023);
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'tablet-1024x768-drawer.png') });
  });
});

test.describe('Desktop 1440x900', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test.beforeEach(async ({ page, request }) => {
    await seedFixture(request);
    await page.goto('/');
    await waitForBoard(page);
  });

  test('multi-column board with all columns visible and side drawer', async ({ page }) => {
    // All four columns fit side by side — no snap rail affordance.
    for (const col of ['Backlog', 'In Progress', 'Review', 'Done']) {
      await expect(page.getByRole('heading', { name: col, exact: true })).toBeInViewport();
    }
    await expect(page.locator('nav[aria-label="Board columns"]')).toBeHidden();
    await expect(page.getByRole('button', { name: 'New Task' })).toBeVisible();

    await openTaskDrawer(page, IN_PROGRESS_TITLE);
    const box = await page.locator('#agent-panel').boundingBox();
    expect(box!.width).toBeLessThanOrEqual(480);
    await expect(page.getByPlaceholder('Send a message to the agent...')).toBeInViewport();
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'desktop-1440x900-drawer.png') });
  });
});
