import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire('/root/.nvm/versions/node/v22.23.4/lib/node_modules/@playwright/mcp/');
const { chromium } = require('playwright-core');
const REPO = '/projects/sandbox/screenshot-graveyard';
const OUT = `${REPO}/docs/screenshots/pixel-world`;
const EXE = '/inner_container/opt/playwright/chromium_headless_shell-1232/chrome-headless-shell-linux64/chrome-headless-shell';
const PAGE_URL = 'http://127.0.0.1:5199/?view=world&demo=1';
const srv = spawn('npx', ['vite', '--port', '5199', '--host', '127.0.0.1'], { cwd: `${REPO}/frontend`, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 5000));
const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--disable-gpu'] });
const report = [];
const log = (...a) => { console.log(...a); report.push(a.join(' ')); };
const TOOLS = [['upload', 'upload-well'], ['calendar', 'clock-tower'], ['notes', 'library'], ['altar', 'approval-altar'], ['crypt', 'crypt'], ['portal', 'portal'], ['queue', 'quick-queue'], ['settings', 'settings']];
for (const [label, vw, vh] of [['desktop', 1280, 720], ['narrow', 390, 844]]) {
  const ctx = await browser.newContext({ viewport: { width: vw, height: vh } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  const apiCalls = [];
  page.on('request', (r) => { if (new URL(r.url()).pathname.startsWith('/api/')) apiCalls.push(r.url()); });
  await page.goto(PAGE_URL); await page.waitForSelector('[data-testid="lumi"]'); await page.waitForTimeout(600);
  const shot = (n) => page.screenshot({ path: `${OUT}/${label}-${n}.png` });
  const overflow = async (tag) => {
    const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth,
      ov: (() => { const d = document.querySelector('[role=dialog]'); return d ? { sw: d.scrollWidth, cw: d.clientWidth } : null; })() }));
    const bad = o.sw > o.iw || (o.ov && o.ov.sw > o.ov.cw);
    log(`[${label}] overflow ${tag}: ${bad ? 'YES' : 'no'} ${JSON.stringify(o)}`);
  };
  await shot('01-world'); await overflow('world');
  const pos = () => page.getByTestId('lumi').evaluate((e) => e.style.transform);
  const p0 = await pos();
  await page.getByRole('application').focus().catch(() => {});
  await page.keyboard.down('ArrowLeft'); await page.waitForTimeout(700); await page.keyboard.up('ArrowLeft');
  await page.keyboard.down('ArrowDown'); await page.waitForTimeout(300); await page.keyboard.up('ArrowDown');
  const p1 = await pos(); log(`[${label}] lumi moved: ${p0} -> ${p1} (${p0 !== p1 ? 'ok' : 'NOT MOVED'})`);
  await shot('02-lumi-moved');
  // ghost card
  const ghost = page.locator('button[data-ghost-id]').first();
  await ghost.click(); await page.waitForSelector('[role=dialog]'); await page.waitForTimeout(300);
  await shot('03-action-card'); await overflow('action-card');
  await page.keyboard.press('Escape'); await page.waitForTimeout(150);
  const f = await page.evaluate(() => document.activeElement?.getAttribute('data-ghost-id'));
  log(`[${label}] focus returned to ghost after Escape: ${f !== null ? 'ok' : 'NO'}`);
  for (const [tool, name] of TOOLS) {
    const HOT = { altar: 'Approval Altar', portal: 'Portal' }; const opener = HOT[tool] ? page.locator(`.pw-hotspot[aria-label="${HOT[tool]}"]`) : page.locator(`[data-tool="${tool}"]`); await opener.click(); await page.waitForSelector('[role=dialog]'); await page.waitForTimeout(250);
    if (tool === 'altar') { await page.getByRole('button', { name: 'Preview stamp' }).click(); await page.waitForTimeout(600); }
    await shot(`04-${name}`); await overflow(name);
    await page.keyboard.press('Escape'); await page.waitForTimeout(150);
    const back = await page.evaluate(() => document.activeElement?.getAttribute('data-tool') ?? document.activeElement?.getAttribute('aria-label'));
    log(`[${label}] ${name}: closed=${(await page.locator('[role=dialog]').count()) === 0} focusBackOnOpener=${back === tool || back === HOT[tool]}`);
  }
  // building hotspot opens
  await page.locator('.pw-hotspot[aria-label="Portal"]').click(); await page.waitForSelector('[role=dialog]');
  log(`[${label}] portal text has "Not connected": ${await page.getByText('Not connected', { exact: true }).count() > 0}; contains delivered: ${/delivered/i.test(await page.locator('body').innerText())}`);
  await page.keyboard.press('Escape');
  log(`[${label}] API requests in demo mode: ${apiCalls.length} ${apiCalls.join(',')}`);
  log(`[${label}] console errors/warnings: ${errors.length}${errors.length ? '\n  ' + errors.join('\n  ') : ''}`);
  await ctx.close();
}
await browser.close(); srv.kill();
