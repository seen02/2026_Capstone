
const fs=require('fs'),path=require('path'),{pathToFileURL}=require('url'),crypto=require('crypto');
const {chromium}=require('C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
(async()=>{
 const root=path.resolve(__dirname,'..'),dir=path.join(root,'대피_건물_구조도'),qa=path.join(__dirname,'cinema-v6-qa');fs.mkdirSync(qa,{recursive:true});
 const errors=[],browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 const page=await browser.newPage({viewport:{width:1020,height:940},deviceScaleFactor:2});
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto(pathToFileURL(path.join(dir,'건물_평면도.svg')).href);await page.evaluate(()=>document.fonts.ready);
 const svg=await page.evaluate(()=>({parserError:!!document.querySelector('parsererror'),seats:document.querySelectorAll('.seat').length,rooms:document.querySelectorAll('.room').length,signs:document.querySelectorAll('.sign').length,viewBox:document.querySelector('svg').getAttribute('viewBox'),clippedText:[...document.querySelectorAll('text')].filter(t=>{const b=t.getBBox(),m=t.getCTM(),corners=[[b.x,b.y],[b.x+b.width,b.y+b.height]].map(([x,y])=>{const p=document.querySelector('svg').createSVGPoint();p.x=x;p.y=y;return p.matrixTransform(m);});return corners.some(p=>p.x<0||p.y<0||p.x>1020||p.y>940);}).map(t=>t.textContent)}));
 await page.locator('svg').screenshot({path:path.join(dir,'건물_평면도.png')});
 await page.setViewportSize({width:1500,height:1100});
 await page.goto(pathToFileURL(path.join(root,'스마트_대피_안내_시스템_프로젝트_계획서_v6.html')).href);await page.evaluate(()=>document.fonts.ready);
 await page.screenshot({path:path.join(qa,'plan-desktop.png')});
 await page.locator('.floorplan').screenshot({path:path.join(qa,'plan-floorplan.png')});
 const desktop=await page.evaluate(()=>({scrollWidth:document.documentElement.scrollWidth,viewport:innerWidth,brokenAnchors:[...document.querySelectorAll('a[href^="#"]')].filter(a=>!document.querySelector(a.getAttribute('href'))).map(a=>a.getAttribute('href')),unloadedImages:[...document.images].filter(i=>!i.complete||i.naturalWidth===0).map(i=>i.alt),floorplans:document.querySelectorAll('.floorplan').length}));
 const embedded=await page.locator('.floorplan').getAttribute('src');
 const embeddedMatches=Buffer.from(embedded.split(',')[1],'base64').equals(fs.readFileSync(path.join(dir,'건물_평면도.svg')));
 const localLinks=await page.locator('a[href]').evaluateAll(els=>els.map(e=>e.getAttribute('href')).filter(h=>h&&!h.startsWith('#')&&!/^https?:/.test(h)));
 const missingFiles=localLinks.filter(h=>!fs.existsSync(path.resolve(root,decodeURIComponent(h))));
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(qa,'plan-mobile.png')});
 const mobile=await page.evaluate(()=>({scrollWidth:document.documentElement.scrollWidth,viewport:innerWidth}));
 await page.setViewportSize({width:800,height:1100});await page.emulateMedia({media:'print'});
 const print=await page.evaluate(()=>({bodyWidth:document.body.getBoundingClientRect().width,navVisible:getComputedStyle(document.querySelector('nav')).display!=='none',floorplanVisible:document.querySelector('.floorplan').naturalWidth>0}));
 const map=JSON.parse(fs.readFileSync(path.join(dir,'building-map-v6.json'),'utf8')),old=JSON.parse(fs.readFileSync(path.join(__dirname,'cinema-v6-originals','building-map-v6.json'),'utf8'));
 const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
 const hash=map.map_hash;delete map.map_hash;
 const result={svg,desktop,mobile,print,embeddedMatches,missingFiles,errors,map:{id:map.map_id,junctions:map.nodes.filter(n=>n.physical_junction).length,exits:map.nodes.filter(n=>n.is_exit).length,edgesPreserved:JSON.stringify(map.edges)===JSON.stringify(old.edges),nodePositionsPreserved:JSON.stringify(map.nodes.map(n=>n.position))===JSON.stringify(old.nodes.map(n=>n.position)),hashValid:hash===crypto.createHash('sha256').update(JSON.stringify(stable(map)),'utf8').digest('hex')}};
 fs.writeFileSync(path.join(qa,'verification.json'),JSON.stringify(result,null,2));
 console.log(JSON.stringify(result,null,2));await browser.close();
})().catch(e=>{console.error(e);process.exitCode=1;});

