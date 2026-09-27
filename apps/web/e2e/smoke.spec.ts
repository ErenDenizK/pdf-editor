import { expect, test } from '@playwright/test';

test('the application shell loads', async ({ page }) => {
  // Relative to baseURL, which already carries the deployment base path.
  await page.goto('./');

  await expect(page).toHaveTitle(/pdf-editor/);
  await expect(page.getByTestId('app-shell')).toBeVisible();
});
