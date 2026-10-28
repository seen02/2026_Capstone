const fs=require('fs'),path=require('path');
const payload=JSON.parse(fs.readFileSync('tmp/hwp-detail-work/expanded-create.json','utf8'));
const out=[];let sections=0,tables=0,images=0;
const cell=s=>String(s).replace(/\|/g,'\\|').replace(/\r?\n/g,'<br>');
for(const op of payload.operations){
  if(op.type==='append_heading'){out.push('#'.repeat(op.level)+' '+op.text);if(op.level===2)sections++;}
  else if(op.type==='append_paragraph'){out.push(op.text.replace(/\r?\n/g,'  \n'));}
  else if(op.type==='append_table'){const rows=[op.headers,op.headers.map(()=> '---'),...op.rows];out.push(rows.map(r=>'| '+r.map(cell).join(' | ')+' |').join('\n'));tables++;}
  else if(op.type==='append_image'){out.push('!['+op.alt+'](<'+op.path.replace(/\\/g,'/')+'>)');images++;}
}
const file=path.resolve('스마트_대피_안내_시스템_상세설계서_상세본.md');
const markdown=out.join('\n\n')+'\n';fs.writeFileSync(file,markdown,'utf8');
const norm=s=>s.replace(/\s/g,'');const expected=JSON.parse(fs.readFileSync('tmp/hwp-detail-work/expanded-content.json','utf8'));
const missing=expected.filter(t=>!norm(markdown).includes(norm(t)));
const imagePaths=payload.operations.filter(o=>o.type==='append_image').map(o=>o.path);
console.log(JSON.stringify({file,sections,tables,images,contentItems:expected.length,allContentPreserved:missing.length===0,imageFilesExist:imagePaths.every(p=>fs.existsSync(p)),bytes:fs.statSync(file).size}));
