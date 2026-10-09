import { test, expect, type Page } from '@playwright/test';
async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('Email address').fill('demo@agentspace.local');
  await page
    .getByLabel('Password', { exact: true })
    .fill(process.env.DEMO_PASSWORD || 'ShopSphere-local-2026!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Production architecture' })).toBeVisible();
}
test('architecture workspace, inspector, command palette, findings, and theme', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await login(page);
  await expect(page.locator('.react-flow__node')).toHaveCount(13);
  await expect(page.getByText('All changes saved')).toBeVisible();
  await page.locator('.react-flow__node').filter({ hasText: 'Payment Service' }).click();
  await expect(page.locator('.inspector h2')).toHaveText('Payment Service');
  await page.getByRole('button', { name: 'Configuration', exact: true }).click();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Payment Service');
  await page.getByRole('button', { name: 'Close inspector' }).click();
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page
    .getByPlaceholder('Search components, findings, agents, actions…')
    .fill('Primary Database');
  await page.getByRole('button', { name: 'Component · Primary Database' }).click();
  await expect(page.locator('.inspector h2')).toHaveText('Primary Database');
  await page.getByRole('button', { name: 'Close inspector' }).click();
  await page
    .locator('nav')
    .getByRole('button', { name: /Findings/ })
    .click();
  await expect(page.getByRole('heading', { name: 'Engineering findings' })).toBeVisible();
  await expect(page.locator('.finding-card').first()).toBeVisible({ timeout: 20000 });
  await page.locator('nav').getByRole('button', { name: 'Architecture', exact: true }).click();
  await page.screenshot({ path: 'test-results/agentspace-workspace.png', fullPage: true });
  await page.getByRole('button', { name: 'Switch to light' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('button', { name: 'Switch to dark' }).click();
  expect(errors).toEqual([]);
});
test('invite a second human and synchronize a committed graph edit', async ({ page, browser }) => {
  await login(page);
  await page.getByRole('button', { name: 'Invite', exact: true }).click();
  await page.getByLabel('Invitation role').selectOption('EDITOR');
  await page.getByRole('button', { name: 'Create share link' }).click();
  const invitation = await page.getByLabel('Invitation link').inputValue();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  const second = await browser.newContext();
  const collaborator = await second.newPage();
  await collaborator.goto(invitation);
  await collaborator.getByRole('button', { name: 'Create account', exact: true }).click();
  await collaborator.getByLabel('Your name').fill('Browser Collaborator');
  await collaborator.getByLabel('Email address').fill(`browser-${Date.now()}@example.test`);
  await collaborator.getByLabel('Password', { exact: true }).fill('Browser-password-2026!');
  await collaborator.getByRole('button', { name: 'Create account', exact: true }).click();
  await collaborator.getByRole('button', { name: /Accept invitation/ }).click();
  await expect(
    collaborator.getByRole('heading', { name: 'Production architecture' }),
  ).toBeVisible();
  await expect(page.locator('.presence-avatars .avatar')).toHaveCount(2, { timeout: 10000 });
  await page.getByRole('button', { name: 'Component', exact: true }).click();
  await page.getByLabel('Component name').fill('Browser test worker');
  await page.getByRole('button', { name: 'Add to architecture' }).click();
  await expect(
    collaborator.locator('.react-flow__node').filter({ hasText: 'Browser test worker' }),
  ).toBeVisible({ timeout: 10000 });
  await page.getByRole('button', { name: 'Undo architecture change' }).click();
  await expect(
    collaborator.locator('.react-flow__node').filter({ hasText: 'Browser test worker' }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Redo architecture change' }).click();
  await expect(
    collaborator.locator('.react-flow__node').filter({ hasText: 'Browser test worker' }),
  ).toBeVisible();
  // Remove the test component through its inspector, proving the editor's authorized path.
  await collaborator
    .locator('.react-flow__node')
    .filter({ hasText: 'Browser test worker' })
    .click();
  await collaborator.getByRole('button', { name: 'Configuration', exact: true }).click();
  await collaborator.getByRole('button', { name: 'Remove component' }).click();
  await collaborator.getByRole('button', { name: 'Confirm removal' }).click();
  await expect(
    page.locator('.react-flow__node').filter({ hasText: 'Browser test worker' }),
  ).toHaveCount(0, { timeout: 10000 });
  await expect(page.getByRole('button', { name: 'Undo architecture change' })).toBeDisabled();
  await second.close();
});
const nav = (page: Page, name: string | RegExp) =>
  page.locator('nav').getByRole('button', { name }).click();

test('observe drift, inbox, discovery import, and agent replies in a thread', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await login(page);
  await expect(page.locator('.react-flow__node').first()).toBeVisible();
  const initial = await page.locator('.react-flow__node').count();

  // The seeded review notifies the owner about findings and proposals.
  await expect(page.locator('.inbox-bell b')).toBeVisible({ timeout: 20000 });
  await nav(page, /Inbox/);
  await expect(page.getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible();
  await expect(page.locator('.inbox-row').filter({ hasText: 'proposed' }).first()).toBeVisible();
  await page.screenshot({ path: 'test-results/agentspace-inbox.png', fullPage: true });

  // Observe mode: the sample manifest differs from the design on purpose.
  await nav(page, /Observe/);
  await page.getByRole('button', { name: 'Load sample Compose file' }).click();
  await page.getByRole('button', { name: 'Compare with design' }).click();
  await expect(page.getByText('Designed connection, not observed')).toBeVisible();
  await expect(page.locator('.drift-row').filter({ hasText: 'Notification Worker' })).toBeVisible();
  await page.screenshot({ path: 'test-results/agentspace-observe.png', fullPage: true });
  await page
    .locator('.drift-row')
    .filter({ hasText: 'Notification Worker' })
    .getByRole('button', { name: 'Add to design' })
    .click();
  await nav(page, 'Architecture');
  await expect(page.locator('.react-flow__node')).toHaveCount(initial + 1);

  // Discovery import keeps existing components and requires an explicit merge.
  await page.getByRole('button', { name: 'Import architecture' }).click();
  await expect(page.getByRole('tab', { name: 'Discover from files' })).toBeVisible();
  await page.getByLabel('File content').fill(
    JSON.stringify({
      name: 'search-service',
      dependencies: { fastify: '5', '@elastic/elasticsearch': '8', ioredis: '5' },
    }),
  );
  await page.getByLabel('File name').fill('package.json');
  await page.getByRole('button', { name: 'Discover architecture' }).click();
  await expect(page.locator('.discovery-item').filter({ hasText: 'search-service' })).toBeVisible();
  await page.screenshot({ path: 'test-results/agentspace-discovery.png' });
  await page.getByRole('button', { name: 'Merge reviewed selection' }).click();
  await expect(page.locator('.react-flow__node')).toHaveCount(initial + 3);

  // An @mention in a component thread gets an answer inside the same thread.
  await page.locator('.react-flow__node').filter({ hasText: 'Payment Service' }).click();
  await page.locator('.inspector').getByRole('button', { name: 'Comments', exact: true }).click();
  await page.getByLabel('Component comment').fill('@Secu');
  await page.getByRole('option', { name: /@SecurityEngineer/ }).click();
  await expect(page.getByLabel('Component comment')).toHaveValue('@SecurityEngineer ');
  await page
    .getByLabel('Component comment')
    .pressSequentially('should this reach Stripe directly?');
  // Graph edits above may have just queued an automatic review; wait for agents to be idle.
  await expect(page.getByText('Your engineering team is ready')).toBeVisible({ timeout: 30000 });
  await page.waitForTimeout(10500);
  await page.locator('.inspector').getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(page.locator('.comment.agent').first()).toBeVisible({ timeout: 30000 });
  await page.screenshot({ path: 'test-results/agentspace-thread.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('conversations: start a thread, agents answer in the thread, artifacts page renders', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await login(page);
  await nav(page, /Conversations/);
  await expect(page.getByRole('heading', { name: 'What are we building?' })).toBeVisible();
  // Offline rule agents are called out; the e2e server has no OpenAI key, so no switch is offered.
  await expect(page.locator('.local-agents-notice')).toContainText('offline rules, not an LLM');
  await expect(page.locator('.local-agents-notice')).toContainText('OPENAI_API_KEY');
  await page.getByLabel('Message', { exact: true }).fill('@Secu');
  await page.getByRole('option', { name: /@SecurityEngineer/ }).click();
  await expect(page.getByLabel('Message', { exact: true })).toBeFocused();
  await page.getByLabel('Message', { exact: true }).pressSequentially('review the public edge');
  await page.getByLabel('Message', { exact: true }).press('Enter');
  await expect(page.locator('.conversation-header h2')).toContainText('@SecurityEngineer review');
  await expect(page.locator('.chat-message.agent').first()).toBeVisible({ timeout: 30000 });
  // Findings already reported by the seeded review are deduplicated, not repeated.
  await expect(page.locator('.chat-message.agent').first()).toContainText('rate limiting');
  await expect(page.locator('.chat-message.agent .steps')).toContainText('Used 1 tool');
  await page.screenshot({ path: 'test-results/agentspace-conversation.png', fullPage: true });
  await nav(page, /Artifacts/);
  await expect(page.getByRole('heading', { name: 'Artifacts', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('a share link brings a teammate straight into a conversation, and chat is live for both', async ({
  page,
  browser,
}) => {
  await login(page);
  await nav(page, /Conversations/);
  await page.getByLabel('Message', { exact: true }).fill('Room for the checkout redesign');
  // No agent should answer here: deselect the default recipient.
  await page.locator('.agent-picks button.picked').click();
  await page.getByLabel('Message', { exact: true }).press('Enter');
  await expect(page.locator('.conversation-header h2')).toHaveText(
    'Room for the checkout redesign',
  );
  await page.getByRole('button', { name: 'Invite to this conversation' }).click();
  await page.getByLabel('Maximum uses').selectOption('5');
  await page.getByRole('button', { name: 'Create share link' }).click();
  const link = await page.getByLabel('Invitation link').inputValue();
  await expect(page.locator('.invite-row').first()).toContainText('0/5 used');
  await page.getByRole('button', { name: 'Close dialog' }).click();

  const second = await browser.newContext();
  const guest = await second.newPage();
  await guest.goto(link);
  await guest.getByRole('button', { name: 'Create account', exact: true }).click();
  await guest.getByLabel('Your name').fill('Link Guest');
  await guest.getByLabel('Email address').fill(`guest-${Date.now()}@example.test`);
  await guest.getByLabel('Password', { exact: true }).fill('Browser-password-2026!');
  await guest.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(guest.getByRole('heading', { name: 'Join ShopSphere' })).toBeVisible();
  await expect(guest.getByText('You will land in')).toContainText('Room for the checkout redesign');
  await guest.getByRole('button', { name: /Accept invitation/ }).click();
  await expect(guest.locator('.conversation-header h2')).toHaveText(
    'Room for the checkout redesign',
  );
  await guest
    .locator('.agent-picks button.picked')
    .click()
    .catch(() => undefined);
  await guest.getByLabel('Message', { exact: true }).fill('Hi, I joined from the link!');
  await guest.getByLabel('Message', { exact: true }).press('Enter');
  await expect(
    page.locator('.chat-message').filter({ hasText: 'Hi, I joined from the link!' }),
  ).toBeVisible({
    timeout: 10000,
  });
  await expect(page.locator('.inbox-bell b')).toBeVisible();
  await page.screenshot({ path: 'test-results/agentspace-invite-room.png', fullPage: true });
  // Revoking from the dialog removes the link from the active list.
  await page.getByRole('button', { name: 'Invite to this conversation' }).click();
  const before = await page.locator('.invite-row').count();
  await page.getByRole('button', { name: 'Revoke invitation' }).first().click();
  await expect(page.locator('.invite-row')).toHaveCount(before - 1);
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await second.close();
});

test('council page: node view, limits, and a clear error without model credentials', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await login(page);
  await nav(page, /Council/);
  await expect(page.getByRole('heading', { name: 'Council', exact: true })).toBeVisible();
  await expect(page.getByText('No council sessions yet')).toBeVisible();
  // The browser-test server has no model keys, so the session stops before any request is sent.
  await page.getByRole('button', { name: 'Start council' }).click();
  await expect(page.locator('.council-flow .council-node')).toHaveCount(9);
  await expect(page.locator('.council-node').filter({ hasText: 'ChatGPT sandbox' })).toBeVisible();
  await expect(page.locator('.council-node').filter({ hasText: 'Gemini sandbox' })).toBeVisible();
  await expect(page.locator('.council-toolbar .badge')).toHaveText('Failed', { timeout: 15000 });
  await expect(page.locator('.council-error')).toContainText('is not configured');
  await expect(page.getByText('400 s', { exact: false }).first()).toBeVisible();
  await expect(page.getByText('No decisions were produced.')).toBeVisible();
  expect(errors).toEqual([]);
});
