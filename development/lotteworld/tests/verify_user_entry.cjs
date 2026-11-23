/* 실행 중인 로컬 서버에서 모바일 QR 진입과 순위 자동 저장을 검증한다. */
const assert = require('node:assert/strict');
const {chromium} = require('playwright');

const base = process.env.MAGIC_USER_URL || 'http://127.0.0.1:3000';
const entry = new URL('/user?sign_id=magic-island-west', base).href;
const sessionUrl = new URL('/api/user/session', base).href;
const sessionOf = async page => (await page.request.get(sessionUrl)).json();
const waitForMapRoute = (page, facilityId) => page.waitForFunction(
  id => window.inspectMagicMap?.().characterRoute?.facility_id === id, facilityId,
);

async function verifySimulatedWait(page, offer) {
  assert.equal(offer.source.kind, 'simulation');
  assert.equal(offer.source.provider_id, 'simulation-queue-v1');
  const wait = Math.ceil(offer.recommendation.wait_seconds / 60);
  assert.equal(await page.locator('#wait-time').textContent(), `${wait}분`);
}

async function verifyFirstScreenFits(page, expectPaired = false) {
  const viewport = page.viewportSize();
  const {clipped, mapHeight, mapRatio, bottomSpace, sideBySide, handleHeight, acceptHeight, overflow} = await page.evaluate(() => {
    const viewport = window.visualViewport;
    const regions = ['.site-header', '#preferences', '#recommendation', '#user-map-frame'];
    const box = selector => document.querySelector(selector).getBoundingClientRect();
    const map = box('#user-map-frame');
    return {
      clipped: regions.filter(selector => {
        const rect = box(selector);
        return rect.left < 0 || rect.top < 0 ||
          rect.right > viewport.width + 1 || rect.bottom > viewport.height + 1;
      }),
      mapHeight: map.height,
      mapRatio: map.width / map.height,
      bottomSpace: viewport.height - map.bottom,
      sideBySide: map.left > box('#recommendation').right,
      handleHeight: box('.drag-handle').height,
      acceptHeight: box('#accept-recommendation').height,
      overflow: document.documentElement.scrollWidth > innerWidth ||
        document.documentElement.scrollHeight > innerHeight + 1,
    };
  });
  assert.deepEqual(clipped, [], viewport.width + '×' + viewport.height + '에서 화면 밖으로 나간 영역');
  assert.ok(!overflow && mapHeight >= 160 && handleHeight >= 44 && acceptHeight >= 44);
  assert.equal(sideBySide, expectPaired);
  if (expectPaired) assert.ok(Math.abs(mapRatio - 4 / 3) < .01);
  else assert.ok(bottomSpace <= 11);
}

async function verifyQueuedSaves(page) {
  const path = '**/api/user/preferences';
  const requests = [];
  let release;
  let started;
  const hold = new Promise(resolve => { release = resolve; });
  const firstRequest = new Promise(resolve => { started = resolve; });
  const delayFirst = async route => {
    requests.push(route.request().postDataJSON());
    if (requests.length === 1) {
      started();
      await hold;
    }
    await route.continue();
  };
  await page.route(path, delayFirst);
  const drop = page.getByRole('button', {name: '자이로드롭 순위 이동'});
  const accept = page.locator('#accept-recommendation');
  const ride = page.locator('#ride-name');
  try {
    await drop.press('ArrowUp');
    await firstRequest;
    await drop.press('ArrowUp');
    assert.equal(requests.length, 1);
    assert.equal(await accept.isDisabled(), true);
    assert.equal(await ride.textContent(), '자이로스핀');
  } finally {
    release();
  }
  await page.waitForFunction(() => document.querySelector('#ride-name').textContent === '자이로드롭');
  assert.equal(requests.length, 2);
  assert.equal(requests[1].expected_revision, requests[0].expected_revision + 1);
  assert.deepEqual((await sessionOf(page)).session.preference_order, requests[1].preference_order);
  await page.unroute(path, delayFirst);

  await page.route(path, route => route.fulfill({status: 503, json: {error: {message: '검증용 저장 오류'}}}), {times: 1});
  await drop.press('ArrowDown');
  await page.locator('#save-error').waitFor();
  assert.equal(await accept.isDisabled(), true);
  assert.deepEqual((await sessionOf(page)).session.preference_order, requests[1].preference_order);
  await page.getByRole('button', {name: '다시 시도'}).tap();
  await page.locator('#save-error').waitFor({state: 'hidden'});
  await page.waitForFunction(() => document.querySelector('#ride-name').textContent === '자이로스핀');
  assert.deepEqual((await sessionOf(page)).session.preference_order, ['gyro-spin', 'gyro-drop', 'comet-express']);
}

async function main() {
  const browser = await chromium.launch({headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome'});
  try {
    const firstContext = await browser.newContext({viewport: {width: 320, height: 720}, isMobile: true, hasTouch: true});
    const secondContext = await browser.newContext({viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true});
    const first = await firstContext.newPage();
    const second = await secondContext.newPage();
    const overview = await browser.newPage({viewport: {width: 1024, height: 900}});
    const errors = [];
    for (const page of [first, second]) {
      page.on('pageerror', error => errors.push(error.message));
    }
    await Promise.all([first.goto(entry), second.goto(entry)]);
    const animationTimes = await first.locator('#splash').evaluate(node =>
      ['.ticket-large', '.splash-brand'].map(selector => getComputedStyle(node.querySelector(selector)).animationDuration));
    assert.deepEqual(animationTimes, ['2s', '2s']);

    for (const page of [first, second]) {
      await page.locator('#preferences').waitFor({timeout: 10000}).catch(async error => {
        throw new Error('QR 연결 상태: ' + await page.locator('#status').textContent() +
          (errors.length ? ' (' + errors.join(', ') + ')' : ''), {cause: error});
      });
      await page.locator('#user-scene[data-rendered="true"]').waitFor();
      assert.equal(await page.locator('#splash').isVisible(), false);
      assert.equal(await page.getByRole('heading', {name: 'Magic Pass'}).count(), 1);
      assert.equal(await page.getByRole('button', {name: '선호 저장'}).count(), 0);
      assert.equal(await page.locator('#ride-name').textContent(), '자이로스핀');
      const {offer} = await sessionOf(page);
      await verifySimulatedWait(page, offer);
      await waitForMapRoute(page, offer.recommendation.facility_id);
      assert.equal(await page.locator('#user-map-frame > button').count(), 0);
      assert.equal(await page.locator('#wait-caption').textContent(), '예상 대기 시간');
      assert.equal(await page.locator('#user-scene .character-label').isVisible(), false);
      assert.equal(await page.locator('#resume-follow').count(), 0);
      const fonts = await page.evaluate(async () => {
        await Promise.all([
          document.fonts.load('16px "Great Vibes"', 'Magic Pass'),
          document.fonts.load('500 16px "Noto Serif KR"', '기다림을 줄이는 마법'),
        ]);
        return [...document.fonts].filter(font => font.status === 'loaded').map(font => font.family.replaceAll('"', ''));
      });
      assert.ok(fonts.includes('Great Vibes') && fonts.includes('Noto Serif KR'));
      const rows = page.locator('#facility-order li');
      assert.deepEqual(await rows.locator('.facility-name').allTextContents(),
                       ['자이로스핀', '혜성특급', '자이로드롭']);
      await verifyFirstScreenFits(page);
      const size = await rows.first().getByRole('button').last().boundingBox();
      assert.ok(size.width >= 44 && size.height >= 44);
    }
    const originalViewport = first.viewportSize();
    for (const [width, height, paired] of [[320, 568, false], [320, 520, false], [667, 375, true],
      [640, 700, true], [1024, 768, true], [1440, 375, true]]) {
      await first.setViewportSize({width, height});
      await verifyFirstScreenFits(first, paired);
    }
    await first.setViewportSize(originalViewport);
    const firstStart = await sessionOf(first);
    const secondStart = await sessionOf(second);
    const characterId = firstStart.character.character_id;
    const secondId = secondStart.character.character_id;
    assert.notEqual(characterId, secondId);
    assert.notDeepEqual(firstStart.character.position.point, secondStart.character.position.point);
    assert.equal(firstStart.character.phase, 'ready');
    assert.equal(secondStart.character.phase, 'ready');
    const moveComet = first.getByRole('button', {name: '혜성특급 순위 이동'});
    const firstFacility = first.locator('#facility-order .facility-name').first();
    await moveComet.scrollIntoViewIfNeeded();
    const from = await moveComet.boundingBox();
    const to = await first.getByRole('button', {name: '자이로스핀 순위 이동'}).boundingBox();
    const touch = await firstContext.newCDPSession(first);
    const point = {id: 1, x: from.x + from.width / 2, y: from.y + from.height / 2};
    await first.bringToFront();
    await touch.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [point]});
    await touch.send('Input.dispatchTouchEvent', {type: 'touchMove', touchPoints: [{...point, y: to.y + 8}]});
    assert.equal((await sessionOf(first)).session.revision, firstStart.session.revision);
    assert.equal(await first.locator('#accept-recommendation').isDisabled(), true);
    await touch.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
    await touch.detach();
    assert.equal(await firstFacility.textContent(), '혜성특급');
    await first.waitForFunction(() => document.querySelector('#ride-name').textContent === '혜성특급');
    await verifySimulatedWait(first, (await sessionOf(first)).offer);
    const response = await first.request.get(new URL('/api/user/recommendation', base).href);
    assert.equal(response.status(), 200);
    const result = await response.json();
    assert.equal(result.recommendation.facility_id, 'comet-express');
    const session = await sessionOf(first);
    assert.equal(session.session.revision, firstStart.session.revision + 1);
    await second.bringToFront();
    await verifyQueuedSaves(second);
    await overview.goto(base);
    await overview.waitForFunction(id => [...document.querySelector('#qr-characters').options].some(option => option.value === id), secondId);
    await overview.locator('#qr-characters').selectOption(characterId);
    await overview.getByText('추천 목적지 · 혜성특급', {exact: true}).waitFor();
    const facilityId = result.recommendation.facility_id;
    await waitForMapRoute(first, facilityId);
    for (const page of [first, overview]) {
      const scene = await page.evaluate(() => window.inspectMagicMap());
      assert.deepEqual(scene.context, session.context);
      assert.deepEqual(scene.characters[characterId], session.character.position.point);
      assert.deepEqual(scene.characterRoute, session.character.route_preview.route);
    }
    assert.deepEqual((await overview.locator('#scene').getAttribute('data-camera-target')).split(',').map(Number),
                     [session.character.position.point[0], 5, session.character.position.point[1]]);
    const secondScene = await second.evaluate(() => window.inspectMagicMap());
    assert.deepEqual(Object.keys(secondScene.characters), [secondId]);
    assert.deepEqual(secondScene.characterRoute, (await sessionOf(second)).character.route_preview.route);
    const userTarget = (await first.locator('#user-scene').getAttribute('data-camera-target')).split(',').map(Number);
    assert.deepEqual([userTarget[0], userTarget[2]], session.character.position.point);
    await first.reload();
    await waitForMapRoute(first, facilityId);
    assert.equal((await sessionOf(first)).character.character_id, characterId);
    assert.equal(await firstFacility.textContent(), '혜성특급');
    assert.notEqual(await second.locator('#facility-order .facility-name').first().textContent(), '혜성특급');

    await first.close();
    const reopened = await firstContext.newPage();
    await reopened.goto(entry);
    await waitForMapRoute(reopened, facilityId);
    assert.equal((await sessionOf(reopened)).character.character_id, characterId);
    await reopened.bringToFront();
    const acceptResponse = reopened.waitForResponse(response =>
      response.url().endsWith('/api/user/recommendation/accept') && response.request().method() === 'POST');
    await reopened.getByRole('button', {name: '수락하고 출발'}).tap();
    assert.equal((await acceptResponse).status(), 200);
    await reopened.locator('#ride-status').getByText('이동 중', {exact: true}).waitFor();
    const startPoint = session.character.position.point;
    await reopened.waitForFunction(({id, start}) => {
      const position = window.inspectMagicMap().characters[id];
      const [x, , z] = document.querySelector('#user-scene').dataset.cameraTarget.split(',').map(Number);
      return position && Math.hypot(position[0] - start[0], position[1] - start[1]) > 1 &&
        Math.hypot(position[0] - x, position[1] - z) < .02;
    }, {id: characterId, start: startPoint});
    await overview.bringToFront();
    await overview.getByText('시설 입구로 이동 중', {exact: true}).waitFor();
    await overview.waitForFunction(({id, start}) => {
      const position = window.inspectMagicMap().characters[id];
      return position && Math.hypot(position[0] - start[0], position[1] - start[1]) > 1;
    }, {id: characterId, start: startPoint});
    const meta = await (await overview.request.get(new URL('/api/meta', base).href)).json();
    const queue = meta.queue_report[facilityId];
    const dispatchesAhead = Math.ceil(queue.capacity / queue.boarding_capacity);
    const dispatchSeconds = meta.ride_operations.facilities[facilityId].dispatch_interval_seconds;
    const boardingTimeout = 90_000 + dispatchesAhead * dispatchSeconds * 1000 / meta.continuous.time_scale;
    let releaseNext;
    const holdNext = new Promise(resolve => { releaseNext = resolve; });
    for (const [simLabel, userLabel] of [
      ['대기열에 합류함', '대기 중'], ['탑승 중', '탑승 중'], ['시설 이용 중', '이용 중'], ['하차 중', '하차 중'],
    ]) {
      await overview.bringToFront();
      await overview.locator('#qr-phase').filter({hasText: simLabel})
        .waitFor({timeout: simLabel === '탑승 중' ? boardingTimeout : 90_000});
      await reopened.bringToFront();
      await reopened.locator('#ride-status').getByText(userLabel, {exact: true}).waitFor({timeout: 30_000});
      assert.equal(await reopened.locator('#ride-status').textContent().then(value => value.trim()), userLabel);
      assert.equal(await reopened.locator('#accept-recommendation').isVisible(), false);
      if (userLabel === '대기 중') {
        assert.match(await overview.locator('#qr-progress').textContent(), /^대기 순서 \d+번째$/);
        await reopened.locator('#queue-place').filter({hasText: /^\d+번째$/}).waitFor();
        assert.match(await reopened.locator('#queue-wait-time').textContent(), /^\d+분$/);
        const [wait, place] = await Promise.all([
          reopened.locator('#queue-wait-time').boundingBox(), reopened.locator('#queue-place').boundingBox(),
        ]);
        assert.ok(Math.abs(wait.y - place.y) < 1 && wait.x + wait.width < place.x);
        assert.equal(await reopened.locator('#ride-wait').isVisible(), false);
      } else {
        assert.equal(await reopened.locator('#ride-wait').isVisible(), false);
        assert.equal(await reopened.locator('#queue-metrics').isVisible(), false);
      }
      if (userLabel === '이용 중') {
        await reopened.route('**/api/user/recommendation', async route => {
          await holdNext;
          await route.continue();
        }, {times: 1});
      }
    }
    await overview.bringToFront();
    await overview.locator('#qr-phase').filter({hasText: '하차 완료'}).waitFor({timeout: 90_000});
    const finished = await sessionOf(reopened);
    const automaticOffer = reopened.waitForResponse(response =>
      response.url().endsWith('/api/user/recommendation') && response.request().method() === 'GET');
    await reopened.bringToFront();
    releaseNext();
    assert.equal((await automaticOffer).status(), 200);
    await reopened.locator('#accept-recommendation').waitFor();
    const autoReady = await sessionOf(reopened);
    assert.equal(autoReady.character.phase, 'ready');
    assert.deepEqual(autoReady.session.preference_order, finished.session.preference_order);
    assert.deepEqual(autoReady.offer.recommendation.route.origin, finished.character.position);
    assert.notEqual(autoReady.offer.recommendation.facility_id, facilityId);
    await verifySimulatedWait(reopened, autoReady.offer);
    await waitForMapRoute(reopened, autoReady.offer.recommendation.facility_id);
    assert.equal(await reopened.getByRole('button', {name: '다음 추천 보기'}).count(), 0);
    const end = finished.character.position.point;
    const atExit = ({id, end}) => {
      const point = window.inspectMagicMap().characters[id];
      return point?.[0] === end[0] && point[1] === end[1];
    };
    await overview.bringToFront();
    await overview.waitForFunction(atExit, {id: characterId, end});
    await reopened.bringToFront();
    await reopened.waitForFunction(atExit, {id: characterId, end});
    const target = (await reopened.locator('#user-scene').getAttribute('data-camera-target')).split(',').map(Number);
    assert.deepEqual([target[0], target[2]], end);
    const drop = reopened.getByRole('button', {name: '자이로드롭 순위 이동'});
    assert.equal(await drop.isEnabled(), true);
    await drop.press('ArrowUp');
    await drop.press('ArrowUp');
    await reopened.waitForFunction(() => document.getElementById('ride-name').textContent === '자이로드롭');
    const nextReady = await sessionOf(reopened);
    await verifySimulatedWait(reopened, nextReady.offer);
    await waitForMapRoute(reopened, nextReady.offer.recommendation.facility_id);
    assert.equal(nextReady.character.character_id, characterId);
    assert.deepEqual(nextReady.character.position, finished.character.position);
    assert.deepEqual(nextReady.offer.recommendation.route.origin, finished.character.position);
    const repeatResponse = reopened.waitForResponse(response =>
      response.url().endsWith('/api/user/recommendation/accept') && response.request().method() === 'POST');
    await reopened.getByRole('button', {name: '수락하고 출발'}).tap();
    assert.equal((await repeatResponse).status(), 200);
    await reopened.locator('#ride-status').getByText('이동 중', {exact: true}).waitFor();
    const secondNow = await sessionOf(second);
    assert.equal(secondNow.character.phase, 'ready');
    await second.goto(new URL('/user?sign_id=unregistered', base).href);
    await second.getByText('등록되지 않은 표지판입니다.', {exact: true}).waitFor();
    assert.equal(await second.locator('#preferences').isVisible(), false);
    assert.deepEqual(errors, []);
    console.log('모바일 QR 화면, 순번 기준 대기 시간, 이용 상태, 하차 후 같은 캐릭터의 재추천과 두 번째 출발 검사 통과');
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
