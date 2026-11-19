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
    const errors = [];
    for (const page of [first, second]) {
      page.on('pageerror', error => errors.push(error.message));
    }
    await Promise.all([first.goto(entry), second.goto(entry)]);

    for (const page of [first, second]) {
      await page.locator('#preferences').waitFor();
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
    const moveComet = first.getByRole('button', {name: '혜성특급 순위 올리기'});
    const firstFacility = first.locator('#facility-order .facility-name').first();
    await moveComet.tap();
    assert.equal(await firstFacility.textContent(), '혜성특급');
    await first.getByRole('button', {name: '선호 저장'}).tap();
    await first.getByText('선호 순위를 저장했습니다.', {exact: true}).waitFor();
    const response = await first.request.get(new URL('/api/user/recommendation', base).href);
    assert.equal(response.status(), 200);
    const result = await response.json();
    assert.equal(result.recommendation.facility_id, 'comet-express');
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
    await second.goto(new URL('/user?sign_id=unregistered', base).href);
    await second.getByText('등록되지 않은 표지판입니다.', {exact: true}).waitFor();
    assert.equal(await second.locator('#preferences').isVisible(), false);
    assert.deepEqual(errors, []);
    console.log('320·390px 모바일 진입, 안내 대상 세 시설, 캐릭터 분리, 순위 저장·복구, 미등록 표지판 검사 통과');
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
