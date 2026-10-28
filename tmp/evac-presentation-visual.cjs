const fs=require('fs');const path=require('path');const {pathToFileURL}=require('url');
const {chromium}=require('C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
(async()=>{
 const dir=path.resolve('tmp/evac-presentation-qa');fs.mkdirSync(dir,{recursive:true});
 const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:900},deviceScaleFactor:1});const errors=[];page.on('pageerror',e=>errors.push(String(e)));
 await page.goto(pathToFileURL(path.resolve('스마트_대피_안내_시스템_발표용_Mockup.html')).href);
 await page.waitForTimeout(400);await page.screenshot({path:path.join(dir,'01-normal.png'),fullPage:true});
 await page.locator('[data-scene="1"]').click();await page.waitForTimeout(400);await page.screenshot({path:path.join(dir,'02-pending.png'),fullPage:true});
 await page.waitForTimeout(5200);await page.screenshot({path:path.join(dir,'03-crowd.png'),fullPage:true});
 await page.locator('[data-scene="2"]').click();await page.waitForTimeout(650);await page.screenshot({path:path.join(dir,'04-risk.png'),fullPage:true});
 await page.locator('[data-scene="3"]').click();await page.waitForTimeout(650);await page.screenshot({path:path.join(dir,'05-blocked.png'),fullPage:true});
 const desktop=await page.evaluate(()=>({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight,state:EVAC_DEMO.snapshot()}));
 await page.setViewportSize({width:1280,height:720});await page.locator('[data-scene="0"]').click();await page.waitForTimeout(400);await page.screenshot({path:path.join(dir,'06-720p.png'),fullPage:true});
 const hd=await page.evaluate(()=>({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight}));
 await page.setViewportSize({width:390,height:844});await page.waitForTimeout(300);await page.screenshot({path:path.join(dir,'07-mobile.png'),fullPage:true});
 const mobile=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth}));
 const result={errors,desktop,hd,mobile};fs.writeFileSync(path.join(dir,'visual-results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));await browser.close();
})();
