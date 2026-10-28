const http=require('http');const fs=require('fs');const path=require('path');
const file=path.resolve('스마트_대피_안내_시스템_발표용_Mockup.html');
http.createServer((req,res)=>{if(req.url==='/'||req.url==='/index.html'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(fs.readFileSync(file));}else if(req.url==='/favicon.ico'){res.writeHead(204);res.end();}else{res.writeHead(404);res.end('Not found');}}).listen(4178,'127.0.0.1',()=>console.log('Preview ready: http://127.0.0.1:4178/'));
