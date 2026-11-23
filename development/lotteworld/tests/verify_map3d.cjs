/* 실행 중인 전용 서버에서 3D 표시·실제 조작·좌표를 검증한다. */
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

async function verifyQrCamera(page, live) {
  const snapshot = structuredClone(live);
  const character = {
    character_id: 'character-camera-test', phase: 'moving', revision: 1,
    position: {point: [101, 149]}, walk_trail: [],
  };
  snapshot.qr.characters = [character];
  const sendCharacter = route => route.fulfill({json: snapshot});
  await page.route('**/api/state', sendCharacter);
  try {
    const picker = page.locator('#qr-characters');
    await picker.selectOption(character.character_id);
    const follow = page.getByRole('button', {name: '캐릭터 확대 및 따라가기'});
    const title = await page.locator('#qr-title').boundingBox();
    const button = await follow.boundingBox();
    assert.ok(Math.abs(button.x - (title.x + title.width) - 4) < 1, 'QR 제목 바로 옆에 돋보기가 있어야 합니다.');
    await follow.click();
    assert.equal(await follow.getAttribute('aria-pressed'), 'true');
    snapshot.clock.sim_time_s += 2;
    character.revision++;
    character.position.point = [104, 150];
    await page.waitForFunction(() => {
      const [x,,z] = document.querySelector('#scene').dataset.cameraTarget.split(',').map(Number);
      return Math.hypot(x - 104, z - 150) < .03;
    });
    await follow.click();
    assert.equal(await follow.getAttribute('aria-pressed'), 'false');
    const camera = await state(page);
    snapshot.clock.sim_time_s += 2;
    character.revision++;
    character.position.point = [107, 151];
    await page.waitForFunction(id => window.inspectMagicMap().characters[id]?.[0] === 107, character.character_id);
    assert.deepEqual(await state(page), camera, '고정을 풀면 캐릭터가 움직여도 시점을 유지해야 합니다.');
    await page.locator('#close-qr').click();
    await page.locator('#reset').click();
  } finally {
    await page.unroute('**/api/state', sendCharacter);
  }
}

function pointInGarden([x, z], outline) {
  let inside = false;
  for (let i = 0; i < outline.length; i++) {
    const [ax, az] = outline[i];
    const [bx, bz] = outline[(i + 1) % outline.length];
    if ((az > z) !== (bz > z) && x < ax + (bx - ax) * (z - az) / (bz - az)) inside = !inside;
  }
  return inside;
}

function distanceToSegment([x, z], [ax, az], [bx, bz]) {
  const dx = bx - ax, dz = bz - az;
  const lengthSquared = dx ** 2 + dz ** 2;
  const t = lengthSquared > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / lengthSquared)) : 0;
  return Math.hypot(x - ax - t * dx, z - az - t * dz);
}

function distanceToRect([x, z], [left, top, width, depth]) {
  return Math.hypot(Math.max(left - x, 0, x - left - width), Math.max(top - z, 0, z - top - depth));
}

function verifyPlantings(scene, map) {
  assert.deepEqual(scene.landscapeBeds, map.geometry.landscape_beds);
  assert.deepEqual(scene.gardens, map.geometry.landscape_areas);
  assert.deepEqual(scene.gardens.map(garden => garden.id).sort(), [
    'castle-east-plaza', 'comet-plaza', 'north-and-east-coast', 'southwest-coast',
  ]);
  assert.deepEqual(scene.gardens.filter(garden => garden.coastal).map(garden => garden.id).sort(), [
    'north-and-east-coast', 'southwest-coast',
  ]);
  assert.ok(scene.gardens.every(garden => garden.outline.length >= 3));
  assert.ok(Number.isFinite(scene.visitorModelHeight) && scene.visitorModelHeight > 0);
  assert.ok(scene.landscapeCrowns.pointed > 0 && scene.landscapeCrowns.rounded > 0);
  assert.equal(scene.landscapeTrees.length, scene.landscapeCrowns.pointed + scene.landscapeCrowns.rounded);
  assert.equal(scene.landscapePlants.length, scene.landscapeTrees.length + scene.landscapeShrubs.length);

  const nodes = Object.fromEntries(map.geometry.nodes.map(({id, point}) => [id, point]));
  const paths = [
    ...map.geometry.edges.map(edge => [nodes[edge.source], nodes[edge.target], edge.width / 2]),
    ...Object.values(scene.queues).map(queue => [queue.boarding_exit, queue.boarding_target, 1.25]),
  ];
  const shoreline = scene.outline.map((point, index) => [point, scene.outline[(index + 1) % scene.outline.length]]);
  const shrubCounts = new Map(scene.gardens.map(garden => [garden.id, 0]));
  let unreservedTrees = 0;
  for (const {x, z, radius, kind, height} of scene.landscapePlants) {
    const point = [x, z];
    const position = `[${x.toFixed(2)}, ${z.toFixed(2)}]`;
    assert.ok(Number.isFinite(radius) && radius > 0);
    const garden = scene.gardens.find(candidate => pointInGarden(point, candidate.outline));
    assert.ok(garden && pointInGarden(point, scene.outline), `식재 중심 ${position}이 섬 안 녹지에 있어야 합니다.`);
    if (kind === 'shrub') {
      const heightRatio = height / scene.visitorModelHeight;
      assert.ok(heightRatio >= .41 - 1e-8 && heightRatio <= .55 + 1e-8,
        `관목 ${position}의 높이가 방문객 모델 높이의 41~55%여야 합니다.`);
      shrubCounts.set(garden.id, shrubCounts.get(garden.id) + 1);
    }
    // 급한 모서리는 그리기 과정에서 둥글게 처리되므로 식재 외곽과의 실제 최소 거리를 본다.
    for (const facility of map.facilities) {
      assert.ok(distanceToRect(point, facility.queue) >= radius + 2.25,
        `식재 ${position}에 ${facility.name} 대기 구획과의 여유가 필요합니다.`);
      assert.ok(distanceToRect(point, facility.exit_area) >= radius + 2.75,
        `식재 ${position}에 ${facility.name} 하차 구획과의 여유가 필요합니다.`);
    }
    const reserved = scene.landscapeBeds.some(([left, top, width, depth]) =>
      left + .6 <= x && x <= left + width - .6 && top + .6 <= z && z <= top + depth - .6);
    if (reserved) continue;
    assert.ok(paths.every(([a, b, halfWidth]) => distanceToSegment(point, a, b) + 1e-8 >=
      Math.max(halfWidth, 7.5) + radius + .75), `예약 구획 밖 식재 ${position}이 보행 범위를 피해야 합니다.`);
    if (kind !== 'shrub') {
      assert.ok(garden.coastal && shoreline.some(([a, b]) => distanceToSegment(point, a, b) < 23),
        `예약 구획 밖 나무 ${position}은 물가 가까운 해안 화단에 있어야 합니다.`);
      unreservedTrees++;
    }
  }
  for (const garden of scene.gardens) {
    assert.ok(shrubCounts.get(garden.id) >= (garden.coastal ? 12 : 4),
      `${garden.id} 녹지에 관목이 충분히 분산되어야 합니다.`);
  }
  assert.ok(unreservedTrees >= 10, '해안의 넓은 녹지에 나무가 분산되어야 합니다.');
}

async function verifyModelJoins(page, map) {
  const failures = await page.evaluate(async ({facilities, geometry}) => {
    const [THREE, {buildRide, buildCastle}] = await Promise.all([import('three'), import('/rides.mjs')]);
    const root = new THREE.Group();
    const rides = Object.fromEntries(facilities.map(facility => [facility.id, buildRide(root, facility)]));
    const {'gyro-spin': spin, 'arcana-ride': arcana, atlantis} = rides;
    const castle = buildCastle(root, geometry.castle, geometry.castle_height_m,
      geometry.castle_forward, geometry.castle_model_scale_xz, geometry.castle_footprint);
    root.updateMatrixWorld(true);

    const failures = [];
    const check = (condition, message) => { if (!condition) failures.push(message); };
    const castleFloor = root.getObjectByName('castle-footprint');
    check(castleFloor?.isMesh, '성 받침이 지도에 정의된 바닥 외곽을 사용해야 합니다.');
    if (castleFloor?.isMesh) {
      const vertices = castleFloor.geometry.getAttribute('position');
      const point = new THREE.Vector3();
      check(geometry.castle_footprint.every(([x, z]) => {
        for (let index = 0; index < vertices.count; index++) {
          point.fromBufferAttribute(vertices, index).applyMatrix4(castleFloor.matrixWorld);
          if (Math.hypot(x - point.x, z - point.z) < .001) return true;
        }
        return false;
      }), '성 받침 메시와 보행 판정의 외곽 좌표가 일치해야 합니다.');
    }
    function localBounds(mesh) {
      mesh.geometry.computeBoundingBox();
      return mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrix);
    }
    function meshMeetsBox(mesh, box) {
      // 상자 로컬 좌표로 변환해 회전한 차량도 실제 삼각형에 닿는지 본다.
      const transform = box.matrixWorld.clone().invert().multiply(mesh.matrixWorld);
      box.geometry.computeBoundingBox();
      const vertices = mesh.geometry.getAttribute('position');
      const indices = mesh.geometry.index.array;
      const triangle = new THREE.Triangle();
      for (let i = 0; i < indices.length; i += 3) {
        triangle.setFromAttributeAndIndices(vertices, indices[i], indices[i + 1], indices[i + 2]);
        triangle.a.applyMatrix4(transform);
        triangle.b.applyMatrix4(transform);
        triangle.c.applyMatrix4(transform);
        if (box.geometry.boundingBox.intersectsTriangle(triangle)) return true;
      }
      return false;
    }

    for (const {id, name, bounds: [x, z, w, d]} of facilities) {
      const floor = rides[id].getObjectByName('ride-floor');
      check(floor?.isMesh, `${name}의 둥근 바닥 메시가 필요합니다.`);
      if (!floor?.isMesh) continue;
      const bounds = new THREE.Box3().setFromObject(floor, true);
      check(bounds.min.x >= x - .01 && bounds.max.x <= x + w + .01 &&
        bounds.min.z >= z - .01 && bounds.max.z <= z + d + .01,
        `${name}의 바닥이 시설 예약 구획을 벗어나면 안 됩니다.`);
      const vertices = floor.geometry.getAttribute('position');
      const footprint = new Set();
      const point = new THREE.Vector3();
      for (let i = 0; i < vertices.count; i++) {
        point.fromBufferAttribute(vertices, i).applyMatrix4(floor.matrixWorld);
        footprint.add(`${point.x.toFixed(4)},${point.z.toFixed(4)}`);
      }
      check(footprint.size > 4, `${name}의 바닥 외곽은 사각형보다 많은 점으로 굴곡을 표현해야 합니다.`);
      for (const cx of [bounds.min.x + .02, bounds.max.x - .02]) {
        for (const cz of [bounds.min.z + .02, bounds.max.z - .02]) {
          const ray = new THREE.Raycaster(new THREE.Vector3(cx, bounds.max.y + 1, cz), new THREE.Vector3(0, -1, 0));
          check(ray.intersectObject(floor, false).length === 0, `${name}의 바닥 모서리가 둥글게 잘려야 합니다.`);
        }
      }
    }

    const platform = spin.getObjectByName('spin-platform');
    const tilt = Math.abs(platform.rotation.z);
    check(tilt > .01 && tilt < .18, '자이로스핀 원판은 작은 경사각을 유지해야 합니다.');
    const rails = spin.getObjectsByProperty('name', 'spin-rail');
    const wheels = platform.getObjectsByProperty('name', 'spin-wheel');
    check(rails.length === 2 && wheels.length === 4, '자이로스핀의 레일 두 줄과 바퀴 네 개가 필요합니다.');
    const down = new THREE.Vector3(0, -1, 0).transformDirection(platform.matrixWorld);
    const carriage = platform.getObjectByName('spin-carriage');
    const carriageBounds = localBounds(carriage);
    for (const wheel of wheels) {
      const radius = wheel.geometry.parameters.radiusTop;
      const ray = new THREE.Raycaster(wheel.getWorldPosition(new THREE.Vector3()), down, 0, radius + .01);
      check(ray.intersectObjects(rails, false).length > 0, '자이로스핀 바퀴가 레일에 닿아야 합니다.');
      const top = wheel.position.clone();
      top.y = localBounds(wheel).max.y;
      check(carriageBounds.containsPoint(top), '자이로스핀 바퀴가 주행대에 맞물려야 합니다.');
    }
    const disk = platform.getObjectByName('spin-disk');
    const diskBounds = localBounds(disk);
    const bearing = platform.getObjectByName('spin-bearing');
    const bearingBounds = localBounds(bearing);
    const bearingBase = new THREE.Vector3(bearing.position.x, bearingBounds.min.y, bearing.position.z);
    check(carriageBounds.containsPoint(bearingBase), '자이로스핀 주행대가 원판 받침축과 맞물려야 합니다.');
    const bearingTop = bearingBase.clone();
    bearingTop.y = bearingBounds.max.y;
    check(diskBounds.containsPoint(bearingTop), '자이로스핀 받침축이 원판 중앙을 받쳐야 합니다.');
    const seats = platform.getObjectsByProperty('name', 'spin-seat');
    check(seats.length === 16, '자이로스핀 좌석 모형 열여섯 개가 필요합니다.');
    const {radiusTop, radialSegments} = disk.geometry.parameters;
    const diskInnerRadius = radiusTop * Math.cos(Math.PI / radialSegments);
    for (const seat of seats) {
      const seatBounds = localBounds(seat);
      const radius = Math.hypot(seat.position.x - disk.position.x, seat.position.z - disk.position.z);
      check(seatBounds.min.y <= diskBounds.max.y && seatBounds.max.y > diskBounds.max.y && radius < diskInnerRadius,
        '자이로스핀 좌석 밑면이 원판 상면에 닿아야 합니다.');
    }

    const walls = arcana.getObjectByName('arcana-pavilion-walls');
    const roof = arcana.getObjectByName('arcana-pavilion-roof');
    const wallBounds = new THREE.Box3().setFromObject(walls);
    const roofBounds = new THREE.Box3().setFromObject(roof);
    check(roofBounds.min.y < wallBounds.max.y && roofBounds.max.y > wallBounds.max.y,
      '아르카나라이드 지붕이 벽 상단에 맞물려야 합니다.');
    for (const x of [wallBounds.min.x, wallBounds.max.x]) {
      for (const z of [wallBounds.min.z, wallBounds.max.z]) {
        const ray = new THREE.Raycaster(new THREE.Vector3(x, roofBounds.max.y + 1, z), new THREE.Vector3(0, -1, 0));
        check(ray.intersectObject(roof, false).some(hit => hit.point.y >= wallBounds.max.y),
          '아르카나라이드 지붕이 벽의 모서리를 덮어야 합니다.');
      }
    }

    const track = atlantis.getObjectByName('atlantis-track');
    const cars = atlantis.getObjectsByProperty('name', 'atlantis-car');
    check(cars.length === 3, '아트란티스 차량 세 대가 필요합니다.');
    for (const car of cars) check(meshMeetsBox(track, car), '아트란티스 차량이 레일에 닿아야 합니다.');

    const wall = castle.getObjectByName('castle-wall');
    const portal = castle.getObjectByName('castle-portal');
    const gate = castle.getObjectByName('castle-gate');
    check(localBounds(portal).intersectsBox(localBounds(gate)), '정문이 출입구 벽과 맞물려야 합니다.');
    check(localBounds(wall).intersectsBox(localBounds(portal)), '출입구 벽이 성 본체와 맞물려야 합니다.');
    const towers = castle.getObjectsByProperty('name', 'castle-tower');
    check(towers.length === 5, '매직캐슬의 탑 다섯 개가 필요합니다.');
    for (const tower of towers) check(meshMeetsBox(tower, wall), '매직캐슬 각 탑이 본체와 맞물려야 합니다.');
    return failures;
  }, map);
  assert.deepEqual(failures, []);
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
      if (width === 1920) await verifyModelJoins(page, meta.map);
      const panel = page.locator('#facility-panel');
      const closePanel = page.locator('#close-panel');
      const mapToolButtons = page.locator('.map-tools > .tool-group > button');
      assert.deepEqual(await mapToolButtons.evaluateAll(buttons => buttons.map(button => button.id)),
        ['reset', 'top-view']);
      assert.deepEqual((await mapToolButtons.allTextContents()).map(text => text.trim()),
        ['전체 보기', '위에서 보기']);
      assert.equal(await page.locator('#display-toggle, #display-panel, #help-toggle, #help-panel, #cutaway').count(), 0);
      assert.equal(await page.locator('#scene canvas').count(), 1);
      const canvas = await page.locator('#scene canvas').boundingBox();
      assert.ok(canvas.width >= width * .9 && canvas.height >= height * .8, '기본 화면 대부분을 지도가 채워야 합니다.');
      assert.equal(await page.locator('.facility-label').count(), 6);
      assert.equal(await page.locator('#facility-list, #facility-picker, #facilities').count(), 0);
      assert.equal(await page.getByRole('button', {name: '시설 찾기', exact: true}).count(), 0);
      assert.equal(await panel.isVisible(), false);
      assert.equal(await page.locator('#show-routes, #route-distances').count(), 0);
      await page.locator('#population').waitFor();
      assert.deepEqual(await page.locator('#population dt').allTextContents(), ['현재 체류', 'QR 참여']);
      const present = Number.parseInt(await page.locator('#present').textContent(), 10);
      assert.ok(present > 0);
      const live = await (await page.request.get(base + '/api/state')).json();
      assert.equal(live.background.entered_total, live.background.present_people + live.background.exited_total);
      assert.deepEqual(await page.evaluate(() => window.inspectMagicMap().context), live.qr.context);
      assert.equal(await page.evaluate(() => window.inspectMagicMap().clock.time_scale), live.clock.time_scale);
      assert.ok(!await page.getByRole('slider').count());
      await page.screenshot({path: path.join(output, `map-${width}.png`), fullPage: true});
      const scene = await page.evaluate(() => window.inspectMagicMap());
      assert.deepEqual(scene.signs, Object.fromEntries(meta.signs.map(sign => [sign.sign_id, sign.position.point])));
      assert.equal(await page.locator('#scene .labels').getByText('QR 안내판', {exact: true}).count(), 0);
      assert.ok(scene.visibleVisitors > 0 && scene.visibleVisitors <= present);
      assert.deepEqual(scene.visitorModels, {heads: scene.visibleVisitors, limbs: scene.visibleVisitors * 4});
      assert.equal(scene.renderer, 'three-webgl'); assert.ok(scene.drawCalls > 0);
      assert.equal(scene.publicSpace,'island-minus-reservations');
      assert.deepEqual(scene.outline, meta.map.geometry.island_outline);
      verifyPlantings(scene, meta.map);
      assert.equal(scene.shorelineRendered, true);
      assert.ok(scene.lakeRippleSegments > 0);
      assert.equal(await page.locator('#scene .labels').getByText('석촌호수', {exact: true}).count(), 0);
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
        assert.deepEqual(object.exitPoint, points[facility.exit]);
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
        assert.equal(await page.locator('[data-queue-capacity]').count(),0);
        await panel.locator('#ride-metrics').waitFor();
        assert.match(await panel.locator('#ride-queue').innerText(), /^\d+명$/);
        assert.match(await panel.locator('#ride-passengers').innerText(), /^\d+명$/);
        assert.deepEqual(await panel.locator('#ride-metrics dt').allTextContents(),
          ['운행 상태', '대기 인원', '예상 대기', '탑승 인원']);
        assert.equal(await panel.locator('details').count(), 0);
        assert.ok(!/대기 수용|\d+\s*자리/.test(await panel.innerText()));
        await closePanel.click();
        assert.equal(await panel.isVisible(), false);
        assert.ok(await label.evaluate(element => element === document.activeElement));
        assert.deepEqual(await state(page), homeBeforeSelection);
      }
      for (const edge of meta.map.geometry.edges) {
        const walk = scene.walks.find(w => w.edgeId === edge.id);
        if (edge.kind !== 'bridge') {
          assert.equal(walk, undefined);
          continue;
        }
        assert.ok(walk, '다리 보행 간선에 데크가 있어야 합니다.');
        assert.equal(walk.width, edge.width);
        const graphStart = points[edge.source];
        const graphEnd = points[edge.target];
        const axis = graphEnd.map((coordinate, i) => coordinate - graphStart[i]);
        const bridgeLength = Math.hypot(...axis);
        const shoreContact = graphStart.map((coordinate, i) => coordinate + 4.8 * axis[i] / bridgeLength);
        assert.ok(Math.hypot(...shoreContact.map((coordinate, i) => coordinate - walk.start[i])) < 1e-6,
          '다리 데크 시작점이 그래프 시작에서 바다 쪽으로 4.8m 떨어진 해안 접합부와 일치해야 합니다.');
        assert.deepEqual(walk.end, graphEnd);
        const visualCenter = walk.start.map((coordinate, i) => (coordinate + walk.end[i]) / 2);
        assert.deepEqual(walk.center, visualCenter);
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
      if (width === 1920) {
        const x = bounds.x + bounds.width * .63;
        const y = bounds.y + bounds.height * .81;
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x, y - bounds.height * .23, {steps: 8});
        await page.mouse.up();
        for (let i = 0; i < 4; i++) await page.locator('#zoom-out').click();
        const side = await state(page);
        const target = side.target.split(',').map(Number);
        const offset = side.position.split(',').map((value, i) => Number(value) - target[i]);
        assert.ok(Math.abs(Math.acos(offset[1] / Math.hypot(...offset)) - Math.PI * .46) < .001);
        const screenshot = await page.locator('#scene canvas').screenshot();
        const columns = await page.evaluate(async (base64) => {
          const image = new Image();
          image.src = 'data:image/png;base64,' + base64;
          await image.decode();
          const sample = document.createElement('canvas').getContext('2d');
          return [.1, .88].map((column) => [.4, .9, .98].map((row) => {
            sample.drawImage(image, Math.floor(image.width * column), Math.floor(image.height * row), 1, 1, 0, 0, 1, 1);
            return [...sample.getImageData(0, 0, 1, 1).data];
          }));
        }, screenshot.toString('base64'));
        for (const [water, lower, bottom] of columns) {
          assert.deepEqual(lower, water, '측면 시점에서도 화면 아래쪽까지 호수색이 이어져야 합니다.');
          assert.deepEqual(bottom, water, '화면 하단 끝까지 같은 호수색이 보여야 합니다.');
        }
        await page.locator('#reset').click(); assert.deepEqual(await state(page), home);
      }
      // 좌표로 3D 탑 모형을 클릭한다. HTML 이름표 선택과 별도로 Raycaster를 검증한다.
      const dropLabel = page.locator('.facility-label[data-facility="gyro-drop"]');
      const drop = await page.evaluate(() => window.inspectMagicMap().pickPoints['gyro-drop']);
      await page.mouse.click(bounds.x + drop[0], bounds.y + drop[1]);
      assert.equal(await page.locator('#detail h2').textContent(), '자이로드롭');
      assert.equal(await panel.isVisible(), true);
      await page.keyboard.press('Escape');
      assert.equal(await panel.isVisible(), false);
      assert.ok(await dropLabel.evaluate(element => element === document.activeElement));
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
      const cometLabel = page.locator('.facility-label[data-facility="comet-express"]');
      await cometLabel.press('Enter');
      assert.equal(await page.locator('#detail h2').textContent(), '혜성특급');
      assert.equal(await panel.isVisible(), true);
      assert.match(await page.locator('#ride-estimated-wait').textContent(), /^약 \d+분$/);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'facility-title');
      await page.locator('[data-action="focus"]').click(); assert.notEqual((await state(page)).target, home.target);
      await page.screenshot({path: path.join(output, `comet-${width}.png`), fullPage: true});
      await closePanel.click();
      assert.ok(await cometLabel.evaluate(element => element === document.activeElement));
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
      if (width === 1920) {
        await verifyQrCamera(page, live);
        await cometLabel.click();
        const beforeUpdate = await page.evaluate(() => window.inspectMagicMap().clock.sim_time_s);
        await page.waitForFunction(previous => window.inspectMagicMap().clock.sim_time_s > previous, beforeUpdate);
        assert.deepEqual(await state(page), home);
        assert.equal(await panel.isVisible(), true);
        const mismatchedState = route => route.fulfill({json: {...live, map_hash: 'other-map'}});
        await page.route('**/api/state', mismatchedState);
        await page.waitForFunction(() => document.querySelector('#map-status').textContent === '지도 버전 불일치 · 새로고침 필요');
        assert.equal(await page.locator('#population').isVisible(), false);
        assert.equal(await page.evaluate(() => window.inspectMagicMap().visibleVisitors), 0);
        await page.unroute('**/api/state', mismatchedState);
        await page.waitForFunction(() => document.querySelector('#map-status').textContent === '시뮬레이션 연결됨');
        assert.equal(await panel.isVisible(), true);
        assert.deepEqual(await state(page), home);
      }
      if (width === 1920 || width === 390) {
        await dropLabel.click();
        await page.locator('[data-action="focus"]').click();
        await page.locator('#zoom-in').click();
        const camera = await state(page);
        await page.locator('#scene canvas').evaluate(el => { window.originalMapCanvas = el; });
        await page.getByRole('tab', {name: '운영자 대시보드'}).click();
        assert.equal(new URL(page.url()).pathname, '/operator');
        assert.equal(await page.locator('#scene canvas').isVisible(), false);
        await page.waitForFunction(() => /명$/.test(document.querySelector('#operator-present').textContent));
        assert.deepEqual(await page.locator('.metric-grid dt').allTextContents(), [
          '현재 체류 인원', '전체 대기 인원', '최장 예상 대기', '혼잡 시설 수',
        ]);
        assert.match(await page.locator('#operator-present').textContent(), /^[\d,]+명$/);
        assert.match(await page.locator('#operator-waiting').textContent(), /^[\d,]+명$/);
        assert.match(await page.locator('#operator-longest-wait').textContent(), /^약 \d+분$/);
        assert.ok(await page.locator('#operator-longest-facility').textContent());
        assert.match(await page.locator('#operator-busy').textContent(), /^\d+곳$/);
        assert.doesNotMatch(await page.locator('.metric-grid').textContent(), /80%/);
        const facilityMap = page.getByRole('group', {name: '매직아일랜드 시설과 안내판 배치'});
        const cometMarker = facilityMap.getByRole('button', {name: '혜성특급 선택', exact: true});
        await cometMarker.waitFor();
        const rideMarkers = facilityMap.locator('.operator-map-marker');
        assert.equal(await rideMarkers.count(), 6);
        assert.deepEqual(await rideMarkers.evaluateAll(buttons =>
          buttons.map(button => button.getAttribute('aria-label'))), [
          '혜성특급 선택', '자이로드롭 선택', '자이로스핀 선택', '자이로스윙 선택', '아르카나라이드 선택', '아트란티스 선택',
        ]);
        assert.equal(await facilityMap.locator('.operator-sign-marker').count(), 2);
        assert.equal(await facilityMap.locator('canvas').count(), 0);
        assert.equal(await facilityMap.evaluate(el => {
          const frame = el.getBoundingClientRect();
          const tiles = [...el.querySelectorAll('.operator-map-marker')].map(button => button.getBoundingClientRect());
          const columns = new Set(tiles.map(tile => Math.round(tile.left)));
          const rows = new Set(tiles.map(tile => Math.round(tile.top)));
          return columns.size === 2 && rows.size === 3 && tiles.every(tile =>
            tile.left >= frame.left && tile.right <= frame.right && tile.top >= frame.top && tile.bottom <= frame.bottom
            && Math.abs(tile.width - tiles[0].width) < 1 && Math.abs(tile.height - tiles[0].height) < 1);
        }), true);
        await cometMarker.click();
        assert.equal(await page.locator('#operator-detail-title').textContent(), '혜성특급');
        assert.equal(await cometMarker.getAttribute('aria-pressed'), 'true');
        const dropMarker = facilityMap.getByRole('button', {name: '자이로드롭 선택', exact: true});
        await dropMarker.press('Enter');
        assert.equal(await page.locator('#operator-detail-title').textContent(), '자이로드롭');
        assert.equal(await dropMarker.getAttribute('aria-pressed'), 'true');
        assert.equal(await cometMarker.getAttribute('aria-pressed'), 'false');
        await cometMarker.click();
        assert.match(await page.locator('#operator-ride-queue').textContent(), /^\d+명$/);
        assert.match(await page.locator('#operator-ride-passengers').textContent(), /^\d+명$/);
        assert.match(await page.locator('#operator-ride-estimated-wait').textContent(), /^약 \d+분$/);
        assert.match(await page.locator('#operator-ride-dispatches').textContent(), /^\d+회$/);
        assert.match(await page.locator('#operator-ride-approaching').textContent(), /^\d+명$/);
        const vehicleDetails = page.locator('#operator-vehicle-details');
        assert.equal(await vehicleDetails.isVisible(), false);
        assert.equal(await vehicleDetails.locator('li').count(), 0);
        assert.match(await page.locator('#operator-ride-status').textContent(),
          /^(출발 대기|승차 중|출발 준비|코스 운행|승강장 대기|하차 중)$/);
        const chart = page.getByRole('img', {name: /방문객 흐름 그래프/});
        await page.locator('#operator-traffic-empty').waitFor({state: 'hidden'});
        assert.match(await chart.getAttribute('aria-label'), /누적 입장 \d+명, 누적 퇴장 \d+명, 현재 체류 \d+명/);
        if (width === 1920) {
          const sample = structuredClone(live);
          Object.assign(sample.background, {entered_total: 432, present_people: 321, exited_total: 111});
          sample.background.visitor_flow = [
            {sim_time_s: 60000, entered_total: 310, exited_total: 50, present_people: 260},
            {sim_time_s: 60060, entered_total: 380, exited_total: 68, present_people: 312},
            {sim_time_s: 60120, entered_total: 432, exited_total: 111, present_people: 321},
          ];
          for (const queue of Object.values(sample.background.queues)) {
            Object.assign(queue, {queued_count: 0, waiting_count: 0, reserved_count: 0, estimated_wait_sim_s: null});
          }
          Object.assign(sample.background.queues['gyro-drop'], {
            queued_count: 7, waiting_count: 7, reserved_count: 7, approaching_count: 33, estimated_wait_sim_s: 121,
          });
          const queue = sample.background.queues['comet-express'];
          Object.assign(queue, {queued_count: 0, waiting_count: 22, estimated_wait_sim_s: 179, reserved_count: queue.capacity});
          sample.rides['comet-express'].riding_people = 8;
          Object.assign(sample.rides['comet-express'].vehicles[0], {state: 'running', station_slot: null, course_section: 2});
          const sampleState = route => route.fulfill({json: sample});
          await page.route('**/api/state', sampleState);
          await page.waitForFunction(() => document.querySelector('#operator-present').textContent === '321명');
          assert.equal(await page.locator('#operator-waiting').textContent(), '29명');
          assert.equal(await page.locator('#operator-longest-wait').textContent(), '약 3분');
          assert.equal(await page.locator('#operator-longest-facility').textContent(), '혜성특급');
          assert.equal(await page.locator('.longest-wait').textContent(), '약 3분 혜성특급');
          assert.equal(await page.locator('#operator-busy').textContent(), '1곳');
          assert.equal(await page.locator('#operator-ride-queue').textContent(), '22명');
          assert.equal(await page.locator('#operator-ride-estimated-wait').textContent(), '약 3분');
          assert.equal(await page.locator('#operator-ride-passengers').textContent(), '8명');
          assert.equal(await page.locator('#operator-ride-status').textContent(), '코스 운행');
          assert.equal(await vehicleDetails.isVisible(), false);
          assert.equal(await cometMarker.getAttribute('data-load'), 'congested');
          assert.equal(await cometMarker.locator('.operator-map-count').textContent(), '22명');
          assert.equal(await cometMarker.locator('.operator-congestion-label').isVisible(), true);
          assert.match(await chart.getAttribute('aria-label'), /기록 3개.*누적 입장 432명, 누적 퇴장 111명, 현재 체류 321명/);
          assert.deepEqual(await chart.evaluate(canvas => {
            const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
            const colors = new Set();
            for (let i = 0; i < data.length; i += 4) {
              if (data[i + 3] === 255) colors.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
            }
            return ['24,104,98', '96,80,153', '164,90,16'].map(color => colors.has(color));
          }), [true, true, true]);
          await page.unroute('**/api/state', sampleState);
        }
        await page.keyboard.press('Escape');
        await page.getByRole('tab', {name: '시뮬레이션'}).click();
        assert.equal(await page.locator('#scene canvas').evaluate(el => el === window.originalMapCanvas), true);
        assert.deepEqual(await state(page), camera);
        assert.equal(await panel.isVisible(), true);
        assert.equal(await page.locator('#facility-title').textContent(), '자이로드롭');
      }
      console.log(`${width}×${height}: 지도 중심 배치·시설 선택 패널·WebGL·모형 6개·회전·확대·시점 복귀 검사 통과`);
      await page.close();
    }
    const operatorPage = await browser.newPage({viewport: {width: 1024, height: 768}});
    await operatorPage.goto(base + '/operator');
    await operatorPage.waitForFunction(() => /명$/.test(document.querySelector('#operator-present').textContent));
    assert.equal(await operatorPage.locator('.workspace-bar [role="status"]').count(), 0);
    assert.equal(await operatorPage.locator('#scene canvas').count(), 0);
    const sign = operatorPage.locator('#operator-facility-map [data-sign-id="magic-island-west"]');
    await sign.click();
    assert.equal(await sign.getAttribute('aria-pressed'), 'true');
    assert.equal(await operatorPage.locator('#operator-sign-name').textContent(), '서쪽 안내판');
    assert.equal(await operatorPage.locator('#operator-sign-facilities').textContent(), '자이로스핀 · 혜성특급 · 자이로드롭');
    assert.equal(await operatorPage.locator('#operator-sign-video-status').textContent(), '연결된 영상이 없습니다');
    const eastSign = operatorPage.getByRole('button', {name: '동쪽 안내판'});
    await eastSign.click();
    assert.equal(await eastSign.getAttribute('aria-pressed'), 'true');
    assert.equal(await sign.getAttribute('aria-pressed'), 'false');
    assert.equal(await operatorPage.locator('#operator-sign-name').textContent(), '동쪽 안내판');
    assert.equal(await operatorPage.locator('#operator-sign-facilities').textContent(), '자이로스윙 · 아트란티스 · 아르카나라이드');
    assert.equal(await operatorPage.locator('#operator-sign-video-status').textContent(), '연결된 영상이 없습니다');
    const dashboard = operatorPage.locator('#operator-panel');
    const plot = operatorPage.locator('.traffic-plot');
    const feed = operatorPage.locator('.operator-sign-feed');
    const [plotHeight, feedHeight] = await Promise.all([plot.boundingBox(), feed.boundingBox()]);
    assert.equal(await dashboard.evaluate(panel => panel.scrollHeight === panel.clientHeight), true);
    await operatorPage.setViewportSize({width: 1024, height: 640});
    assert.equal(await dashboard.evaluate(panel => panel.scrollHeight === panel.clientHeight), true);
    assert.ok((await plot.boundingBox()).height < plotHeight.height);
    assert.ok((await feed.boundingBox()).height < feedHeight.height);
    await operatorPage.getByRole('button', {name: '아트란티스 선택'}).click();
    const detail = operatorPage.locator('#operator-detail');
    assert.equal(await detail.locator('#operator-ride-vehicles li').count(), 8);
    for (const [width, height] of [[1024, 640], [1024, 768], [1536, 864]]) {
      await operatorPage.setViewportSize({width, height});
      const [summary, facilityMap, visitorFlow, facilityDetail, signPanel] = await operatorPage.evaluate(() =>
        ['.metric-grid', '#operator-facilities', '#traffic', '#operator-detail', '#signs'].map(selector => {
          const element = document.querySelector(selector);
          const {x, y, height} = element.getBoundingClientRect();
          return {x, y, height, overflow: element.scrollHeight - element.clientHeight};
        }));
      assert.equal(facilityMap.y, visitorFlow.y);
      assert.equal(facilityMap.x, facilityDetail.x);
      assert.ok(visitorFlow.x > facilityMap.x && facilityDetail.y > facilityMap.y);
      assert.equal(facilityDetail.y, signPanel.y);
      assert.equal(facilityDetail.overflow, 0);
      assert.equal(facilityMap.overflow, 0);
      assert.deepEqual(await detail.evaluate(panel => ['.detail-list', '#operator-ride-vehicles'].map(selector =>
        getComputedStyle(panel.querySelector(selector)).gridTemplateColumns.split(' ').length)), [2, 2]);
      const panelHeight = summary.height + facilityMap.height + facilityDetail.height;
      for (const [panel, expected] of [[summary, .13], [facilityMap, .42], [facilityDetail, .45]]) {
        assert.ok(Math.abs(panel.height / panelHeight - expected) < .001);
      }
      assert.equal(await dashboard.evaluate(panel => panel.scrollHeight === panel.clientHeight), true);
    }
    const unavailableState = route => route.fulfill({status: 503});
    await operatorPage.route('**/api/state', unavailableState);
    await operatorPage.waitForFunction(() => document.querySelector('#map-status').textContent === '운영 상태 갱신 지연');
    assert.equal(await operatorPage.locator('.workspace-bar [role="status"]').count(), 0);
    assert.match(await operatorPage.locator('#operator-present').textContent(), /^[\d,]+명$/);
    await operatorPage.unroute('**/api/state', unavailableState);
    await operatorPage.waitForFunction(() => document.querySelector('#map-status').textContent === '시뮬레이션 연결됨');
    await operatorPage.getByRole('tab', {name: '운영자 대시보드'}).press('ArrowLeft');
    await operatorPage.locator('#scene canvas').waitFor();
    await operatorPage.goBack();
    assert.equal(await operatorPage.locator('#operator-tab').getAttribute('aria-selected'), 'true');
    await operatorPage.close();
    console.log('운영자 대시보드 직접 진입·갱신 지연과 복구·키보드 전환·뒤로 가기 검사 통과');
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
