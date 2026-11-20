/* 실행 중인 로컬 서버에서 모바일 QR 진입과 순위 저장을 검증한다. */
const assert = require('node:assert/strict');
const {chromium} = require('playwright');

const base = process.env.MAGIC_USER_URL || 'http://127.0.0.1:8767';
const entry = new URL('/user?sign_id=magic-island-west', base).href;

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

    for (const page of [first, second]) {
      await page.locator('#preferences').waitFor({timeout: 10000}).catch(async error => {
        throw new Error(`QR 연결 상태: ${await page.locator('#status').textContent()}`, {cause: error});
      });
      await page.locator('#user-scene[data-rendered="true"]').waitFor();
      const rows = page.locator('#facility-order li');
      assert.deepEqual(await rows.locator('.facility-name').allTextContents(),
                       ['자이로스핀', '혜성특급', '자이로드롭']);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      const size = await rows.first().getByRole('button').last().boundingBox();
      assert.ok(size.width >= 44 && size.height >= 44);
    }
    const firstCharacter = first.locator('#character-id');
    const characterId = await firstCharacter.textContent();
    assert.notEqual(characterId, await second.locator('#character-id').textContent());
    assert.notEqual(await first.locator('#character-position').textContent(),
                    await second.locator('#character-position').textContent());
    const moveComet = first.getByRole('button', {name: '혜성특급 순위 이동'});
    const firstFacility = first.locator('#facility-order .facility-name').first();
    await moveComet.scrollIntoViewIfNeeded();
    const from = await moveComet.boundingBox();
    const to = await first.getByRole('button', {name: '자이로스핀 순위 이동'}).boundingBox();
    const touch = await firstContext.newCDPSession(first);
    const point = {id: 1, x: from.x + from.width / 2, y: from.y + from.height / 2};
    await touch.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [point]});
    await touch.send('Input.dispatchTouchEvent', {type: 'touchMove', touchPoints: [{...point, y: to.y + 8}]});
    await touch.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
    await touch.detach();
    assert.equal(await firstFacility.textContent(), '혜성특급');
    const keyboardHandle = second.getByRole('button', {name: '자이로드롭 순위 이동'});
    await keyboardHandle.press('ArrowUp');
    assert.equal(await second.locator('#facility-order .facility-name').nth(1).textContent(), '자이로드롭');
    await first.bringToFront();
    await first.getByRole('button', {name: '선호 저장'}).tap();
    const status = first.locator('#status');
    await first.waitForFunction(() => {
      const status = document.querySelector('#status');
      return status.hasAttribute('data-error') || status.textContent === '선호 순위를 저장했습니다.';
    }, null, {timeout: 8000}).catch(async error => {
      throw new Error(`선호 저장 후 표시 상태: ${await status.textContent()}`, {cause: error});
    });
    assert.equal(await status.textContent(), '선호 순위를 저장했습니다.');
    const response = await first.request.get(new URL('/api/user/recommendation', base).href);
    assert.equal(response.status(), 200);
    const result = await response.json();
    assert.equal(result.recommendation.facility_id, 'comet-express');
    const session = await (await first.request.get(new URL('/api/user/session', base).href)).json();
    const secondId = await second.locator('#character-id').textContent();
    await overview.goto(base);
    await overview.waitForFunction(id => [...document.querySelector('#qr-characters').options].some(option => option.value === id), secondId);
    await overview.locator('#qr-characters').selectOption(characterId);
    await overview.getByText('모의 추천 목적지 · 혜성특급', {exact: true}).waitFor();
    await first.getByText('모의 추천 목적지 · 혜성특급', {exact: true}).waitFor();
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
    assert.equal(secondScene.characterRoute, null);
    const userScene = first.locator('#user-scene');
    const originalTarget = await userScene.getAttribute('data-camera-target');
    const resume = first.getByRole('button', {name: '내 캐릭터 다시 따라가기'});
    assert.equal(await resume.isVisible(), false);
    await first.getByRole('button', {name: '모의 추천 목적지 · 혜성특급 경로 보기'}).tap();
    assert.notEqual(await userScene.getAttribute('data-camera-target'), originalTarget);
    await resume.tap();
    assert.equal(await userScene.getAttribute('data-camera-target'), originalTarget);
    await first.reload();
    await first.getByText('저장한 선호 순위를 불러왔습니다.', {exact: true}).waitFor();
    assert.equal(await firstCharacter.textContent(), characterId);
    assert.equal(await firstFacility.textContent(), '혜성특급');
    assert.notEqual(await second.locator('#facility-order .facility-name').first().textContent(), '혜성특급');

    await first.close();
    const reopened = await firstContext.newPage();
    await reopened.goto(entry);
    await reopened.getByText('저장한 선호 순위를 불러왔습니다.', {exact: true}).waitFor();
    assert.equal(await reopened.locator('#character-id').textContent(), characterId);
    await reopened.bringToFront();
    const acceptResponse = reopened.waitForResponse(response =>
      response.url().endsWith('/api/user/recommendation/accept') && response.request().method() === 'POST');
    await reopened.getByRole('button', {name: '추천 수락하고 출발'}).tap();
    assert.equal((await acceptResponse).status(), 200);
    await reopened.getByText('시설 입구로 이동 중', {exact: true}).waitFor();
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
    const facilityId = result.recommendation.facility_id;
    const queue = meta.queue_report[facilityId];
    const dispatchesAhead = Math.ceil(queue.capacity / queue.boarding_capacity);
    const dispatchSeconds = meta.ride_operations.facilities[facilityId].dispatch_interval_seconds;
    const boardingTimeout = 90_000 + dispatchesAhead * dispatchSeconds * 1000 / meta.continuous.time_scale;
    for (const phase of ['대기열에 합류함', '탑승 중', '시설 이용 중', '하차 중', '하차 완료']) {
      for (const page of [overview, reopened]) {
        await page.bringToFront();
        await page.getByText(phase, {exact: true}).waitFor({timeout: phase === '탑승 중' ? boardingTimeout : 90_000});
      }
      if (phase === '대기열에 합류함') {
        assert.match(await overview.locator('#qr-progress').textContent(), /^대기 순서 \d+번째$/);
        assert.match(await reopened.locator('#character-progress').textContent(), /^대기 순서 \d+번째$/);
      }
      if (phase === '시설 이용 중') {
        assert.equal(await reopened.locator('#character-progress').textContent(),
                     await overview.locator('#qr-progress').textContent());
        assert.match(await reopened.locator('#character-progress').textContent(), /^차량 \d+번$/);
      }
    }
    const finished = await (await reopened.request.get(new URL('/api/user/session', base).href)).json();
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
    const secondNow = await (await second.request.get(new URL('/api/user/session', base).href)).json();
    assert.equal(secondNow.character.phase, 'awaiting_preferences');
    await second.goto(new URL('/user?sign_id=unregistered', base).href);
    await second.getByText('등록되지 않은 표지판입니다.', {exact: true}).waitFor();
    assert.equal(await second.locator('#preferences').isVisible(), false);
    assert.deepEqual(errors, []);
    console.log('320·390px QR 지도, 추천 수락부터 두 지도의 대기·탑승·하차 완료, 차량 번호 일치와 모바일 카메라 추적 검사 통과');
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
