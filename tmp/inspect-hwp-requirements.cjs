const fs=require('fs'),{execFileSync}=require('child_process'),crypto=require('crypto');
const base='C:/Users/admin/.codex/plugins/cache/claw-hwp/claw-hwp/1.5.58/skills/hwp/scripts/';
const file='C:/컴퓨터공학 종합설계/컴퓨터공학_종합설계_과제지원신청서_과제계획서_작성본.hwp';
const data=JSON.parse(execFileSync(process.execPath,[base+'extract_text.js','--inspect','--with-cell-text',file],{encoding:'utf8'}));
console.log(JSON.stringify({pageCount:data.pageCount,tableCount:data.tableCount,cellCount:data.cellCount,requirements:data.tables.find(t=>t.para===24)},null,2));
fs.mkdirSync('tmp/hwp-requirements-work',{recursive:true});
fs.writeFileSync('tmp/hwp-requirements-work/before-hashes.json',JSON.stringify({tables:data.tables.map(t=>({para:t.para,ctrl:t.ctrl,hash:crypto.createHash('sha256').update(JSON.stringify(t)).digest('hex')}))},null,2));
