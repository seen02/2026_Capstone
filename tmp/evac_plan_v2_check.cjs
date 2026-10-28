const fs=require('fs');const path=require('path');const {pathToFileURL}=require('url');
const {chromium}=require('C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
(async()=>{
 const dir=path.resolve('tmp/evac_plan_v2_qa');
 const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 const page=await browser.newPage({viewport:{width:1500,height:1100},deviceScaleFactor:1});
 const errors=[];page.on('pageerror',e=>errors.push(String(e)));
 await page.goto(pathToFileURL(path.resolve('스마트_대피_안내_시스템_프로젝트_계획서_v2.html')).href);
 await page.screenshot({path:path.join(dir,'opening.png')});
 const diagrams=page.locator('.diagram');for(let i=0;i<await diagrams.count();i++)await diagrams.nth(i).screenshot({path:path.join(dir,`diagram-${i+1}.png`)});
 const desktop=await page.evaluate(()=>({width:document.documentElement.scrollWidth,viewport:innerWidth,tables:document.querySelectorAll('table').length,diagrams:document.querySelectorAll('svg').length,brokenLinks:[...document.querySelectorAll('a[href^="#"]')].filter(a=>!document.querySelector(a.getAttribute('href'))).length}));
 await page.pdf({path:path.join(dir,'print.pdf'),format:'A4',preferCSSPageSize:true,printBackground:true,displayHeaderFooter:true,headerTemplate:'<span></span>',footerTemplate:'<div style="width:100%;text-align:center;font-size:9px;color:#6b7280"><span class="pageNumber"></span> / <span class="totalPages"></span></div>'});
 await page.setViewportSize({width:390,height:844});await page.goto(pathToFileURL(path.resolve('스마트_대피_안내_시스템_프로젝트_계획서_v2.html')).href);await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:path.join(dir,'mobile.png')});
 const mobile=await page.evaluate(()=>({width:document.documentElement.scrollWidth,viewport:innerWidth}));
 console.log(JSON.stringify({desktop,mobile,errors}));await browser.close();
})();

