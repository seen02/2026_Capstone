/* 실행 중인 전용 서버에서 3D 표시·실제 조작·좌표·경로를 검증한다. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {chromium} = require('playwright');
let base = process.env.MAGIC_MAP_URL;
let server;
const output = path.resolve(__dirname, '../output/map3d-verification');
const features = {
  'gyro-drop': 'vertical-tower', 'gyro-swing': 'pendulum', atlantis: 'water-channel',
  'comet-express': 'ground-platform', 'gyro-spin': 'u-rail', 'arcana-ride': 'small-cars'
};

async function state(page) {
  return page.locator('#scene').evaluate(el => ({zoom: el.dataset.cameraZoom, position: el.dataset.cameraPosition, target: el.dataset.cameraTarget}));
}

(async () => {
  fs.mkdirSync(output, {recursive: true});
  if (!base) {
    const bundled = 'C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
    server = spawn(process.env.PYTHON || (fs.existsSync(bundled) ? bundled : 'python'), ['-m', 'lotteworld_sim.server', '--port', '0'], {
      cwd: path.resolve(__dirname, '..'), env: {...process.env, PYTHONUTF8: '1'}, windowsHide: true
    });
    base = await new Promise((resolve, reject) => {
      let stderr = '';
      const timeout = setTimeout(() => { server.kill(); reject(new Error('검증 서버 시작 시간 초과')); }, 15000);
      server.stderr.on('data', chunk => { stderr += chunk.toString(); });
      server.stdout.on('data', chunk => {
        const match = chunk.toString().match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) { clearTimeout(timeout); resolve(match[0]); }
      });
      server.once('error', error => { clearTimeout(timeout); reject(error); });
      server.once('exit', code => { clearTimeout(timeout); reject(new Error(`검증 서버 종료 ${code}: ${stderr}`)); });
    });
  }
  const browser = await chromium.launch({headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome'});
  try {
    for (const [width, height] of [[1600, 1100], [1024, 900], [390, 844]]) {
      const page = await browser.newPage({viewport: {width, height}, hasTouch: width === 390});
      const errors = [], failed = [], remote = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('response', response => { if (response.status() >= 400) failed.push(response.url()); });
      page.on('request', request => { if (!request.url().startsWith(base) && !request.url().startsWith('data:')) remote.push(request.url()); });
      await page.goto(base);
      await page.waitForFunction(() => window.inspectMagicMap, {timeout: 30000});
      const meta = await (await page.request.get(base + '/api/meta')).json();
      assert.equal(meta.runnable, false); assert.equal(meta.map_view, 'guide-map-3d');
      assert.equal(await page.locator('#scene canvas').count(), 1);
      assert.equal(await page.locator('.facility-label').count(), 6);
      assert.equal(await page.locator('#facilities button').count(), 6);
      const scene = await page.evaluate(() => window.inspectMagicMap());
      assert.equal(scene.renderer, 'three-webgl'); assert.ok(scene.drawCalls > 0);
      assert.equal(scene.publicSpace,'island-minus-reservations');
      assert.deepEqual(scene.landscapeBeds,meta.map.geometry.landscape_beds);
      const points = Object.fromEntries(meta.map.geometry.nodes.map(n => [n.id, n.point]));
      const gate=scene.castleGate,bridgeStart=points['bridge-island'],bridgeEnd=points[meta.map.geometry.boundary];
      const dx=bridgeEnd[0]-bridgeStart[0],dz=bridgeEnd[1]-bridgeStart[1];
      assert.ok(Math.abs((gate[0]-bridgeStart[0])*dz-(gate[2]-bridgeStart[1])*dx)/Math.hypot(dx,dz)<1e-5,'성 정문과 다리 축');
      const [castleX,castleZ,castleW,castleD]=meta.map.geometry.castle;
      assert.ok(scene.castleBounds.min[0]>=castleX-.01 && scene.castleBounds.max[0]<=castleX+castleW+.01);
      assert.ok(scene.castleBounds.min[2]>=castleZ-.01 && scene.castleBounds.max[2]<=castleZ+castleD+.01);
      for (const facility of meta.map.facilities) {
        const object = scene.facilities[facility.id];
        const [x, z, w, d] = facility.bounds;
        assert.ok(object.features.includes(features[facility.id]));
        // 실제 현장 치수가 아닌 표시 모형의 점유 구획을 검사한다.
        assert.ok(object.min[0] >= x - .01 && object.max[0] <= x + w + .01, facility.id + ' 가로 범위');
        assert.ok(object.min[2] >= z - .01 && object.max[2] <= z + d + .01, facility.id + ' 세로 범위');
        assert.equal(facility.level,0);
        assert.ok(object.min[1] >= -.7 && object.max[1] > 5);
        assert.equal(await page.locator(`.facility-label[data-facility="${facility.id}"]`).isVisible(), true);
        await page.locator(`#facilities [data-facility="${facility.id}"]`).click();
        assert.equal(await page.locator('#detail h2').textContent(), facility.name);
        const routes = await page.evaluate(() => window.inspectMagicMap().routes);
        assert.equal(routes.length, 2);
        assert.equal(routes[0].nodes[0], meta.map.geometry.boundary);
        assert.equal(routes[0].nodes.at(-1), facility.entrance);
        assert.equal(routes[1].nodes[0], facility.exit);
        assert.equal(routes[1].nodes.at(-1), meta.map.geometry.boundary);
        const text = await page.locator('#detail').textContent();
        for (const route of routes) {
          const distance = route.nodes.slice(1).reduce((sum, key, i) => sum + Math.hypot(points[key][0] - points[route.nodes[i]][0], points[key][1] - points[route.nodes[i]][1]), 0);
          assert.ok(Math.abs(distance - route.distance_m) < 1e-8);
          assert.ok(text.includes(distance.toFixed(1) + 'm'));
        }
      }
      for (const edge of meta.map.geometry.edges) {
        const walk = scene.walks.find(w => w.edgeId === edge.id);
        assert.equal(walk.width, edge.width);
        assert.deepEqual(walk.center, [0, 1].map(i => (points[edge.source][i] + points[edge.target][i]) / 2));
      }
      const home = await state(page);
      await page.locator('#zoom-in').click(); assert.ok(Number((await state(page)).zoom) > Number(home.zoom));
      await page.locator('#zoom-out').click(); assert.equal((await state(page)).zoom, home.zoom);
      const bounds = await page.locator('#scene canvas').boundingBox();
      const start = {x: bounds.x + bounds.width * .48, y: bounds.y + bounds.height * .8};
      await page.mouse.move(start.x, start.y); await page.mouse.down();
      await page.mouse.move(start.x + 50, start.y - 20, {steps: 8}); await page.mouse.up();
      assert.notEqual((await state(page)).position, home.position);
      const beforePan = await state(page);
      await page.mouse.move(start.x, start.y); await page.mouse.down({button: 'right'});
      await page.mouse.move(start.x - 30, start.y + 15, {steps: 5}); await page.mouse.up({button: 'right'});
      assert.notEqual((await state(page)).target, beforePan.target);
      const beforeWheel = Number((await state(page)).zoom);
      await page.mouse.wheel(0, -120);
      await page.waitForFunction(z => Number(document.querySelector('#scene').dataset.cameraZoom) > z, beforeWheel);
      await page.locator('#reset').click(); assert.deepEqual(await state(page), home);
      // 좌표로 3D 탑 모형을 클릭한다. HTML 이름표 선택과 별도로 Raycaster를 검증한다.
      const drop = await page.evaluate(() => window.inspectMagicMap().pickPoints['gyro-drop']);
      await page.mouse.click(bounds.x + drop[0], bounds.y + drop[1]);
      assert.equal(await page.locator('#detail h2').textContent(), '자이로드롭');
      await page.locator('#top-view').click(); assert.notEqual((await state(page)).position, home.position);
      await page.screenshot({path: path.join(output, `top-${width}.png`), fullPage: true});
      await page.locator('#cutaway').click();
      assert.equal(await page.evaluate(() => window.inspectMagicMap().castleOpacity), .14);
      await page.locator('#cutaway').click(); assert.equal(await page.evaluate(() => window.inspectMagicMap().castleOpacity), 1);
      await page.locator('#reset').click();
      if (width === 390) {
        const cdp = await page.context().newCDPSession(page);
        const beforeTouch = await state(page);
        await cdp.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [{x: start.x, y: start.y, id: 1}]});
        await cdp.send('Input.dispatchTouchEvent', {type: 'touchMove', touchPoints: [{x: start.x + 40, y: start.y - 20, id: 1}]});
        await cdp.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
        assert.notEqual((await state(page)).position, beforeTouch.position);
        const beforePinch = Number((await state(page)).zoom);
        await cdp.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [{x: start.x - 30, y: start.y, id: 1}, {x: start.x + 30, y: start.y, id: 2}]});
        await cdp.send('Input.dispatchTouchEvent', {type: 'touchMove', touchPoints: [{x: start.x - 50, y: start.y, id: 1}, {x: start.x + 50, y: start.y, id: 2}]});
        await cdp.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
        assert.ok(Number((await state(page)).zoom) > beforePinch);
        await page.locator('#reset').click();
      }
      await page.locator('#facilities [data-facility="comet-express"]').focus(); await page.keyboard.press('Enter');
      assert.equal(await page.locator('#detail h2').textContent(), '혜성특급');
      await page.locator('[data-action="focus"]').click(); assert.notEqual((await state(page)).target, home.target);
      await page.screenshot({path: path.join(output, `comet-${width}.png`), fullPage: true});
      await page.locator('#reset').click(); assert.deepEqual(await state(page), home);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(errors, []); assert.deepEqual(failed, []); assert.deepEqual(remote, []);
      await page.screenshot({path: path.join(output, `map-${width}.png`), fullPage: true});
      assert.equal(await page.locator('body').textContent().then(text=>text.includes('지하 B1')),false);
      console.log(`${width}×${height}: WebGL·지상 모형 6개·점유 범위·동선·회전·확대·이동·시점 복귀·외부 요청 없음 검사 통과`);
      await page.close();
    }
  } finally { await browser.close(); server?.kill(); }
})().catch(error => { server?.kill(); console.error(error); process.exitCode = 1; });
