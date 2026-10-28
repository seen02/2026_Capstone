const fs=require('fs');
const template=fs.readFileSync('tmp/evac-presentation.template.html','utf8');
const engine=fs.readFileSync('tmp/evac-presentation-engine.js','utf8');
const ui=fs.readFileSync('tmp/evac-presentation-ui.js','utf8');
const output=template.replace('/* ENGINE_PLACEHOLDER */',()=>engine).replace('/* UI_PLACEHOLDER */',()=>ui);
if(output.includes('PLACEHOLDER */'))throw Error('Unresolved placeholder');
fs.writeFileSync('스마트_대피_안내_시스템_발표용_Mockup.html',output,'utf8');
console.log(JSON.stringify({bytes:Buffer.byteLength(output),file:'스마트_대피_안내_시스템_발표용_Mockup.html'}));
