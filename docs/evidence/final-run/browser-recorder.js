const { chromium } = require('/home/abstergo/.agents/skills/playwright/node_modules/playwright');
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--disable-gpu','--disable-dev-shm-usage','--disable-extensions'] });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, recordVideo: { dir: '/tmp/circe-final/rec', size: { width: 1920, height: 1080 } } });
  const t0 = Date.now();
  const mark = (m) => console.log(`${new Date().toISOString()} +${((Date.now()-t0)/1000).toFixed(2)}s ${m}`);
  const page = await context.newPage();
  mark('page created (video clock starts ~here)');
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  try {
    await page.goto('http://127.0.0.1:4318', { waitUntil: 'domcontentloaded' });
    mark('loaded');
    await page.waitForTimeout(2500);
    await page.getByRole('button', { name: 'Start actual agent run' }).click();
    mark('clicked start');
    let last = 0;
    await page.waitForFunction(() => ['PASSED','FAILED'].includes(document.querySelector('#state').textContent), {}, { timeout: 900000, polling: 1000 });
    const state = await page.locator('#state').textContent();
    mark('state ' + state);
    await page.screenshot({ path: '/tmp/circe-final/after.png' });
    await page.waitForTimeout(4000);
    const video = page.video();
    await context.close();
    mark('video ' + await video.path());
    if (state !== 'PASSED') { console.log(await page.locator('#log').textContent().catch(()=>'')); process.exitCode = 1; }
    if (errors.length) console.log('pageerrors', errors);
  } finally { await browser.close(); }
})();
