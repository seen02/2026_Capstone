/* 실행 중인 전용 서버에서 3D 표시·실제 조작·좌표·경로를 검증한다. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {chromium} = require('playwright');
let base = process.env.MAGIC_MAP_URL;
let server;
let reloadConfig;
const output = path.resolve(__dirname, '../output/map3d-verification');
const features = {
  'gyro-drop': 'vertical-tower', 'gyro-swing': 'pendulum', atlantis: 'water-channel',
  'comet-express': 'ground-platform', 'gyro-spin': 'u-rail', 'arcana-ride': 'small-cars'
};

async function state(page) {
  return page.locator('#scene').evaluate(el => ({zoom: el.dataset.cameraZoom, position: el.dataset.cameraPosition, target: el.dataset.cameraTarget}));
}

async function routesInScene(page) {
  return page.evaluate(() => window.inspectMagicMap().routes);
}

(async () => {
  fs.mkdirSync(output, {recursive: true});
  if (!base) {
    const bundled = 'C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
    reloadConfig=path.join(output,`reload-day-${process.pid}.json`);
    fs.copyFileSync(path.resolve(__dirname,'../configs/day.json'),reloadConfig);
    server = spawn(process.env.PYTHON || (fs.existsSync(bundled) ? bundled : 'python'), ['-m', 'lotteworld_sim.server', '--port', '0','--no-reload','--config',reloadConfig], {
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
    for (const [width, height] of [[1920, 1080], [1024, 900], [390, 844]]) {
      const page = await browser.newPage({viewport: {width, height}, hasTouch: width === 390});
      const errors = [], failed = [], remote = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('response', response => { if (response.status() >= 400) failed.push(response.url()); });
      page.on('request', request => { if (!request.url().startsWith(base) && !request.url().startsWith('data:')) remote.push(request.url()); });
      await page.goto(base);
      await page.waitForFunction(() => window.inspectMagicMap, null, {timeout: 30000});
      const meta = await (await page.request.get(base + '/api/meta')).json();
      if(width===1920&&reloadConfig){
        const before=await (await page.request.get(base+'/api/dev-version')).json();
        const next=JSON.parse(fs.readFileSync(reloadConfig,'utf8'));next.seed+=1;fs.writeFileSync(reloadConfig,JSON.stringify(next));
        await page.reload();await page.waitForFunction(()=>window.inspectMagicMap);
        const refreshed=await (await page.request.get(base+'/api/meta')).json();
        const after=await (await page.request.get(base+'/api/dev-version')).json();
        assert.equal(refreshed.config.seed,next.seed);assert.equal(after.instance,before.instance);assert.notEqual(after.version,before.version);
      }
      assert.equal(meta.runnable, true); assert.equal(meta.status, 'continuous_running'); assert.equal(meta.map_view, 'guide-map-3d');
      const panel = page.locator('#facility-panel');
      const closePanel = page.locator('#close-panel');
      const showRoutes = page.locator('#show-routes');
      const routeDistances = page.locator('#route-distances');
      const facilityList = page.locator('#facility-list');
      const mapToolButtons = page.locator('.map-tools > .tool-group > button');
      assert.deepEqual(await mapToolButtons.evaluateAll(buttons => buttons.map(button => button.id)),
        ['reset', 'top-view', 'facility-list']);
      assert.deepEqual((await mapToolButtons.allTextContents()).map(text => text.trim()),
        ['전체 보기', '위에서 보기', '시설 찾기']);
      assert.equal(await page.locator('#display-toggle, #display-panel, #help-toggle, #help-panel, #cutaway').count(), 0);
      assert.equal(await page.locator('#scene canvas').count(), 1);
      const canvas = await page.locator('#scene canvas').boundingBox();
      assert.ok(canvas.width >= width * .9 && canvas.height >= height * .8, '기본 화면 대부분을 지도가 채워야 합니다.');
      assert.equal(await page.locator('.facility-label').count(), 6);
      assert.equal(await page.locator('#facilities button').count(), 6);
      assert.equal(await page.locator('#facility-picker').isVisible(), false);
      assert.equal(await panel.isVisible(), false);
      assert.deepEqual(await routesInScene(page), []);
      assert.ok(!/\d+\s*(?:명|분|자리)|운행\s*(?:중|정지)|재생바/.test(await page.locator('body').innerText()));
      await page.screenshot({path: path.join(output, `map-${width}.png`), fullPage: true});
      const scene = await page.evaluate(() => window.inspectMagicMap());
      assert.equal(scene.renderer, 'three-webgl'); assert.ok(scene.drawCalls > 0);
      assert.equal(scene.publicSpace,'island-minus-reservations');
      assert.deepEqual(scene.landscapeBeds,meta.map.geometry.landscape_beds);
      assert.equal(scene.plazaOverlayCount,0);
      assert.deepEqual(scene.surfaceMeshes.sort(),['public-pavement',...meta.map.geometry.edges.filter(e=>e.kind==='bridge').map(e=>'walk:'+e.id)].sort());
      assert.equal(Object.keys(scene.queues).length,6);
      for(const [id,queue] of Object.entries(scene.queues)){
        assert.equal(queue.capacity,meta.queue_report[id].capacity);
        assert.deepEqual(queue.slots,meta.queue_report[id].slots);
        assert.ok(queue.meets_minimum);
        assert.deepEqual(queue.railPaths,meta.queue_report[id].railPaths);
        assert.equal(queue.railPaths.length,3);
        assert.deepEqual(queue.points,meta.queue_report[id].points);
        assert.deepEqual(queue.withdrawal,meta.queue_report[id].withdrawal);
        assert.deepEqual(queue.boarding_exit,meta.queue_report[id].boarding_exit);
        assert.deepEqual(queue.points.at(-1),queue.boarding_exit);
      }
      assert.ok(!(await page.locator('#scene .labels').allTextContents()).some(text=>text==='대기줄'||text==='탑승 진입'));
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
        const label = page.locator(`.facility-label[data-facility="${facility.id}"]`);
        const homeBeforeSelection = await state(page);
        await label.click();
        assert.equal(await panel.isVisible(), true);
        assert.equal(await page.locator('#detail h2').textContent(), facility.name);
        assert.deepEqual(await state(page), homeBeforeSelection, '시설 선택 시 카메라를 옮기지 않습니다.');
        assert.deepEqual(await page.locator('#scene canvas').boundingBox(), canvas);
        assert.deepEqual(await routesInScene(page), [], '경로는 버튼으로 요청한 경우에만 표시합니다.');
        assert.equal(await showRoutes.getAttribute('aria-pressed'), 'false');
        assert.equal(await routeDistances.isVisible(), false);
        assert.equal(await page.locator('[data-queue-capacity]').count(),0);
        assert.ok(!/대기 수용|\d+\s*(?:명|분|자리)|운행\s*(?:중|정지)/.test(await panel.innerText()));
        await showRoutes.click();
        assert.equal(await showRoutes.getAttribute('aria-pressed'), 'true');
        assert.equal(await routeDistances.isVisible(), true);
        const routes = await routesInScene(page);
        assert.equal(routes.length, 2);
        assert.equal(routes[0].nodes[0], meta.map.geometry.boundary);
        assert.equal(routes[0].nodes.at(-1), facility.entrance);
        assert.equal(routes[1].nodes[0], facility.exit);
        assert.equal(routes[1].nodes.at(-1), meta.map.geometry.boundary);
        const text = await page.locator('#detail').textContent();
        for (const route of routes) {
          assert.equal(route.mode,'open-plaza');
          const distance = route.points.slice(1).reduce((sum,p,i) => sum + Math.hypot(p[0]-route.points[i][0],p[1]-route.points[i][1]),0);
          assert.ok(Math.abs(distance - route.distance_m) < 1e-8);
          assert.ok(text.includes(distance.toFixed(1) + 'm'));
        }
        await showRoutes.click();
        assert.equal(await showRoutes.getAttribute('aria-pressed'), 'false');
        assert.equal(await routeDistances.isVisible(), false);
        assert.deepEqual(await routesInScene(page), []);
        await closePanel.click();
        assert.equal(await panel.isVisible(), false);
        assert.deepEqual(await state(page), homeBeforeSelection);
      }
      for (const edge of meta.map.geometry.edges) {
        const walk = scene.walks.find(w => w.edgeId === edge.id);
        if(edge.kind!=='bridge'){assert.equal(walk,undefined);continue;}
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
      assert.equal(await panel.isVisible(), true);
      await page.keyboard.press('Escape');
      assert.equal(await panel.isVisible(), false);
      await page.locator('#top-view').click(); assert.notEqual((await state(page)).position, home.position);
      await page.screenshot({path: path.join(output, `top-${width}.png`), fullPage: true});
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
      await facilityList.click();
      assert.equal(await facilityList.getAttribute('aria-expanded'), 'true');
      assert.equal(await page.locator('#facilities').isVisible(), true);
      await page.locator('#facilities [data-facility="comet-express"]').focus();
      await page.keyboard.press('Enter');
      assert.equal(await page.locator('#detail h2').textContent(), '혜성특급');
      assert.equal(await panel.isVisible(), true);
      assert.equal(await page.locator('#facility-picker').isVisible(), false);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'facility-title');
      await showRoutes.click();
      await page.locator('[data-action="focus"]').click(); assert.notEqual((await state(page)).target, home.target);
      await page.screenshot({path: path.join(output, `comet-${width}.png`), fullPage: true});
      await closePanel.click();
      assert.deepEqual(await routesInScene(page), []);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'facility-list');
      await page.locator('#reset').click(); assert.deepEqual(await state(page), home);
      if (width === 1920 && await page.evaluate(() => document.fullscreenEnabled)) {
        const fullscreen = page.locator('#fullscreen');
        await fullscreen.click();
        await page.waitForFunction(() =>
          document.fullscreenElement !== null && document.querySelector('#fullscreen').ariaPressed === 'true');
        await fullscreen.click();
        await page.waitForFunction(() =>
          document.fullscreenElement === null && document.querySelector('#fullscreen').ariaPressed === 'false');
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight), true);
      assert.deepEqual(errors, []); assert.deepEqual(failed, []); assert.deepEqual(remote, []);
      assert.equal(await page.locator('body').textContent().then(text=>text.includes('지하 B1')),false);
      console.log(`${width}×${height}: 지도 중심 배치·시설 선택 패널·동선 전환·WebGL·모형 6개·회전·확대·시점 복귀 검사 통과`);
      await page.close();
    }
    const errorPage = await browser.newPage();
    await errorPage.route('**/api/meta', route => route.fulfill({status: 503}));
    await errorPage.goto(base);
    await errorPage.locator('#error').waitFor({state: 'visible'});
    assert.equal(await errorPage.locator('#map-status').textContent(), '지도 표시 오류');
    assert.equal(await errorPage.locator('#scene canvas').count(), 0);
    assert.equal(await errorPage.locator('#facility-panel').isVisible(), false);
    console.log('지도 요청 실패 시 오류 표시 검사 통과');
    await errorPage.close();
  } finally { await browser.close(); server?.kill(); if(reloadConfig&&fs.existsSync(reloadConfig))fs.unlinkSync(reloadConfig); }
})().catch(error => { server?.kill(); if(reloadConfig&&fs.existsSync(reloadConfig))fs.unlinkSync(reloadConfig); console.error(error); process.exitCode = 1; });
