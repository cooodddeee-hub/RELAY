import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const css = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');

test('signed-in shell exposes accessible mobile navigation and project workspace tabs', () => {
  assert.match(html, /aria-controls="sidebar"[^>]*aria-expanded="false"[^>]*id="mobileNavToggle"/);
  assert.match(html, /role="tablist" aria-label="Project workspace sections"/);
  assert.match(html, /role="tabpanel" tabindex="0"/);
  assert.match(html, /id="sidebarBackdrop"/);
  assert.match(html, /id="desktopSidebarToggle"[^>]*toggleDesktopSidebar\(\)/);
  assert.match(css, /#app\.sidebar-collapsed #mainShell/);
  assert.match(html, /id="toast" role="status" aria-live="polite"/);
  assert.match(html, /role="dialog" aria-modal="true"/);
});

test('dashboard values are live render targets instead of sample metric values', () => {
  assert.match(html, /id="dashboardProjectCount"[^>]*>—</);
  assert.match(html, /id="dashboardSourceCount"[^>]*>—</);
  assert.match(html, /id="dashboardFindingCount"[^>]*>—</);
  assert.doesNotMatch(html, /Sources \(8\)|Findings \(47\)|dashboardReadiness[^<]*>94%/);
  assert.match(html, /id="dashboardRecentHandovers"/);
  assert.match(html, /Good to see you, <span id="greetName">there<\/span>/);
  assert.doesNotMatch(html, /Good morning, <span id="greetName">Sarah<\/span>/);
  assert.match(html, /class="dashboard-quick-actions/);
  assert.match(html, /onclick="navigate\('sources'\)" class="quick-action"/);
});

test('premium stylesheet defines responsive tokens, visible focus and reduced-motion support', () => {
  assert.match(css, /--relay-canvas/);
  assert.match(css, /--relay-indigo/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /@media \(max-width: 640px\)/);
});

test('startup splash and premium auth screens expose branded accessible states without sample metrics', () => {
  assert.match(html, /id="welcomeSplash" class="welcome-splash" role="status" aria-live="polite" aria-busy="true"/);
  assert.match(html, /Welcome, <span>Code Pune Thinkers\.<\/span>/);
  assert.match(html, /Connecting ideas\. Reconstructing knowledge\. Building trust\./);
  assert.match(html, /Turn project knowledge into <em>trusted decisions\.<\/em>/);
  assert.match(html, /id="authForm"/);
  assert.match(html, /id="authEmail" type="email" autocomplete="email" required/);
  assert.match(html, /id="authPass" type="password" autocomplete="current-password" required/);
  assert.match(html, /id="togglePassButton" type="button" onclick="togglePass\(\)" aria-label="Show password" aria-pressed="false"/);
  assert.match(html, /id="authSwitch" onclick="toggleAuthMode\(\)"/);
  assert.doesNotMatch(html, /47 <span|128 links|94%/);
  assert.match(css, /@media \(max-width: 800px\)/);
  assert.match(css, /prefers-reduced-motion: reduce/);
});
