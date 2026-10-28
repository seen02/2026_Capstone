const { chromium } = require('C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const target = 'file:///C:/컴퓨터공학%20종합설계/스마트_대피_안내_시스템_발표용_Mockup.html';
const outputDir = 'C:/컴퓨터공학 종합설계/tmp';
const results = [];

(async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const consoleErrors = [];
  page.on('pageerror', error => consoleErrors.push(error.message));
  await page.clock.install({ time: new Date('2026-09-23T03:00:00Z') });
  await page.goto(target);
  await page.clock.pauseAt(new Date('2026-09-23T03:00:01Z'));
  const snapshot = () => page.evaluate(() => window.EVAC_DEMO.snapshot());
  const outputs = s => ['S1', 'S2', 'S3'].map(id => s.model.signs[id].status === 'route' ? s.model.signs[id].direction : s.model.signs[id].status);
  const step = async (name, run) => {
    try { await run(); results.push({ name, pass: true }); console.log('PASS ' + name); }
    catch (error) { results.push({ name, pass: false, error: error.message }); console.log('FAIL ' + name + ': ' + error.message); }
  };
  const scene = n => page.locator('[data-scene="' + (n - 1) + '"]').click();
  const bodyFocus = () => page.locator('#headline').click();
  const closeDialogs = async () => {
    for (const dialog of await page.locator('dialog[open]').all()) await dialog.locator('[data-close]').first().click();
  };

  await step('Scene 01 shows L/L/R and correct 60-person distribution', async () => {
    const s = await snapshot();
    assert.equal(s.scene, 1);
    assert.deepEqual(outputs(s), ['left', 'left', 'right']);
    assert.equal(s.model.crowd, 0);
    assert.equal(s.model.waiting, 60);
  });

  await step('Scene 02 genuinely waits 5 seconds before R/R/R', async () => {
    await scene(2);
    let s = await snapshot();
    assert.deepEqual(outputs(s), ['left', 'left', 'right']);
    assert.equal(s.model.signs.S1.pendingSeconds, 5);
    await page.clock.runFor(4900);
    assert.equal((await snapshot()).model.signs.S1.direction, 'left');
    await page.clock.runFor(200);
    assert.deepEqual(outputs(await snapshot()), ['right', 'right', 'right']);
    assert.match(await page.locator('#destination').innerText(), /출구 B/);
  });

  await step('Scene 03 immediately shows L/L/X with crowd retained', async () => {
    await scene(3);
    const s = await snapshot();
    assert.deepEqual(outputs(s), ['left', 'left', 'stop']);
    assert.equal(s.model.crowd, 30);
    assert.equal(s.model.signs.S1.pendingSeconds, 0);
    assert.equal(await page.locator('#hazardB').evaluate(el => el.hasAttribute('hidden')), false);
  });

  await step('Scene 04 immediately shows X/X/X', async () => {
    await scene(4);
    assert.deepEqual(outputs(await snapshot()), ['stop', 'stop', 'stop']);
    assert.match(await page.locator('#destination').innerText(), /안내 불가/);
  });

  await step('Previous/next buttons and arrow/number shortcuts select scenes', async () => {
    await page.locator('#prevBtn').click();
    assert.equal((await snapshot()).scene, 3);
    await page.locator('#nextBtn').click();
    assert.equal((await snapshot()).scene, 4);
    await bodyFocus();
    await page.keyboard.press('ArrowLeft');
    assert.equal((await snapshot()).scene, 3);
    await page.keyboard.press('1');
    assert.equal((await snapshot()).scene, 1);
    assert.equal(await page.locator('#prevBtn').isDisabled(), true);
    await page.keyboard.press('ArrowRight');
    assert.equal((await snapshot()).scene, 2);
  });

  await step('Space starts, pauses, and resumes automatic timeline', async () => {
    await scene(1);
    await bodyFocus();
    await page.keyboard.press('Space');
    assert.equal((await snapshot()).automatic, true);
    await page.clock.runFor(3000);
    await page.keyboard.press('Space');
    const paused = await snapshot();
    assert.equal(paused.paused, true);
    await page.clock.runFor(7000);
    assert.equal((await snapshot()).total, paused.total);
    await page.keyboard.press('Space');
    await page.clock.runFor(1000);
    const resumed = await snapshot();
    assert.equal(resumed.paused, false);
    assert.ok(resumed.total > paused.total);
  });

  await step('Notes dialog freezes both timeline and pending calculation; remains paused after close', async () => {
    await scene(1);
    await page.locator('#autoBtn').click();
    await page.clock.runFor(26200);
    assert.equal((await snapshot()).scene, 2);
    await page.locator('#notesBtn').click();
    const before = await snapshot();
    assert.equal(before.paused, true);
    assert.ok(before.model.signs.S1.pendingSeconds > 0);
    await page.clock.runFor(15000);
    const during = await snapshot();
    assert.equal(during.total, before.total);
    assert.equal(during.model.signs.S1.pendingSeconds, before.model.signs.S1.pendingSeconds);
    await page.locator('#notesDialog [data-close]').first().click();
    await page.clock.runFor(2000);
    assert.equal((await snapshot()).total, before.total);
    assert.equal((await snapshot()).paused, true);
    await page.locator('#autoBtn').click();
    await page.clock.runFor(5100);
    assert.deepEqual(outputs(await snapshot()), ['right', 'right', 'right']);
  });

  await step('Complete automatic run visits all four stages, ends at 90 seconds, and never loops', async () => {
    await scene(1);
    await page.locator('#autoBtn').click();
    await page.clock.runFor(25100);
    assert.equal((await snapshot()).scene, 2);
    await page.clock.runFor(5100);
    assert.deepEqual(outputs(await snapshot()), ['right', 'right', 'right']);
    await page.clock.runFor(15000);
    assert.equal((await snapshot()).scene, 3);
    assert.deepEqual(outputs(await snapshot()), ['left', 'left', 'stop']);
    await page.clock.runFor(20000);
    assert.equal((await snapshot()).scene, 4);
    assert.deepEqual(outputs(await snapshot()), ['stop', 'stop', 'stop']);
    await page.clock.runFor(25100);
    let s = await snapshot();
    assert.equal(s.total, 90000);
    assert.equal(s.automatic, false);
    assert.equal(await page.locator('#endDialog').evaluate(el => el.open), true);
    await page.clock.runFor(120000);
    s = await snapshot();
    assert.equal(s.scene, 4);
    assert.equal(s.total, 90000);
    assert.equal(s.automatic, false);
    await page.locator('#endDialog [data-close]').click();
  });

  await step('Manual scene selection cancels auto advance and discards old candidate timers', async () => {
    await scene(1);
    await page.locator('#autoBtn').click();
    await page.clock.runFor(26200);
    assert.equal((await snapshot()).scene, 2);
    await scene(1);
    await page.clock.runFor(120000);
    const s = await snapshot();
    assert.equal(s.automatic, false);
    assert.equal(s.scene, 1);
    assert.deepEqual(outputs(s), ['left', 'left', 'right']);
    assert.equal(s.model.signs.S1.pendingSeconds, 0);
    assert.equal(await page.locator('dialog[open]').count(), 0);
  });

  await step('Entering explore stops auto advance', async () => {
    await page.locator('#autoBtn').click();
    await page.clock.runFor(1000);
    await page.locator('#exploreBtn').click();
    const s = await snapshot();
    assert.equal(s.explore, true);
    assert.equal(s.automatic, false);
    await page.clock.runFor(100000);
    assert.equal((await snapshot()).scene, 1);
  });

  await step('Explore G disconnect retains previous crowd, then immediately falls back after 5 seconds', async () => {
    await page.locator('#crowdRange').fill('30');
    await page.locator('#crowdRange').dispatchEvent('input');
    await page.clock.runFor(5100);
    assert.equal((await snapshot()).model.signs.S1.direction, 'right');
    await page.locator('#gatewayDown').check();
    await page.clock.runFor(4900);
    assert.equal((await snapshot()).model.stale, false);
    await page.clock.runFor(200);
    const s = await snapshot();
    assert.equal(s.model.stale, true);
    assert.equal(s.model.signs.S1.direction, 'left');
    assert.equal(s.model.signs.S1.pendingSeconds, 0);
  });

  await step('Explore S3 disconnect makes OFF immediately and UNKNOWN after 3 seconds', async () => {
    await page.locator('#restoreBtn').click();
    await page.locator('#peopleReset').click();
    await page.locator('#s3Down').check();
    assert.equal((await snapshot()).model.signs.S3.status, 'offline');
    assert.equal((await snapshot()).model.risks.e4, 'CLEAR');
    await page.clock.runFor(3100);
    assert.equal((await snapshot()).model.risks.e4, 'UNKNOWN');
    await page.locator('#riskA').check();
    const s = await snapshot();
    assert.equal(s.model.signs.S1.status, 'unknown');
    assert.equal(s.model.signs.S2.status, 'unknown');
    assert.match(await page.locator('#destination').innerText(), /정보 미확인/);
  });

  await step('People reset preserves hazard inputs and both disconnected devices', async () => {
    await page.locator('#restoreBtn').click();
    await page.locator('#crowdRange').fill('30');
    await page.locator('#crowdRange').dispatchEvent('input');
    await page.locator('#riskA').check();
    await page.locator('#riskB').check();
    await page.locator('#gatewayDown').check();
    await page.locator('#s3Down').check();
    await page.locator('#peopleReset').click();
    const s = await snapshot();
    assert.equal(s.model.crowd, 0);
    assert.equal(s.model.gatewayDown, true);
    assert.equal(s.model.s3Down, true);
    assert.equal(s.model.risks.e3, 'BLOCKED');
    assert.equal(s.model.risks.e4, 'BLOCKED');
    assert.equal(await page.locator('#riskA').isChecked(), true);
    assert.equal(await page.locator('#riskB').isChecked(), true);
    await page.clock.runFor(10000);
    assert.equal((await snapshot()).model.risks.e4, 'BLOCKED');
  });

  await step('Offline BLOCKED survives local clear until source recovery', async () => {
    await page.locator('#riskB').uncheck();
    assert.equal((await snapshot()).model.risks.e4, 'BLOCKED');
    assert.equal(await page.locator('#riskB').isChecked(), false);
    await page.locator('#s3Down').uncheck();
    assert.equal((await snapshot()).model.risks.e4, 'CLEAR');
  });

  await step('Record download is valid JSON with mockup scope and current state', async () => {
    const event = page.waitForEvent('download');
    await page.locator('#exportBtn').click();
    const download = await event;
    const savePath = path.join(outputDir, 'evac-presentation-functional-export.json');
    await download.saveAs(savePath);
    const parsed = JSON.parse(fs.readFileSync(savePath, 'utf8'));
    assert.equal(parsed.hardware_connected, false);
    assert.equal(parsed.software_mockup, true);
    assert.equal(parsed.snapshot.crowd, 0);
    assert.equal(parsed.snapshot.gatewayDown, true);
    assert.equal(parsed.risk_inputs.e3, true);
    assert.ok(Array.isArray(parsed.snapshot.events));
    assert.ok(Array.isArray(parsed.previous_scenes));
  });

  await step('All browser interactions produced no uncaught JavaScript errors', async () => {
    assert.deepEqual(consoleErrors, []);
  });

  const report = { passed: results.filter(r => r.pass).length, failed: results.filter(r => !r.pass).length, results, consoleErrors };
  fs.writeFileSync(path.join(outputDir, 'evac-presentation-functional-results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, failed: report.failed }, null, 2));
  await browser.close();
  if (report.failed) process.exitCode = 1;
})();
