// Local OTLP acceptance recorder. Never points at the shared Demo tenant.
import { createServer } from 'node:http';
import { mkdir, appendFile, readFile } from 'node:fs/promises';
const records: unknown[]=[];const port=Number(process.env.CAPTURE_PORT||4411);
const server=createServer(async(req,res)=>{
  res.setHeader('Access-Control-Allow-Origin',req.headers.origin||'http://localhost:4101');res.setHeader('Access-Control-Allow-Headers','Content-Type,X-CORRIDORA-KEY');res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');res.setHeader('Vary','Origin');
  if(req.method==='OPTIONS'){res.writeHead(204).end();return;}
  if(req.url==='/records'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(records));return;}
  if(req.url==='/healthz'){res.end('ok');return;}
  if(req.url?.startsWith('/corridora-rum.js')&&process.env.RUM_BUNDLE_PATH){res.setHeader('Content-Type','text/javascript');res.end(await readFile(process.env.RUM_BUNDLE_PATH));return;}
  let body='';for await(const part of req){body+=part;if(body.length>2_000_000){res.writeHead(413).end();return;}}
  if(!/^\/v1\/(traces|logs|metrics)/.test(req.url||'')){res.writeHead(404).end();return;}
  try{const key=req.headers['x-corridora-key'];if(!['test-backend-key','test-browser-key'].includes(String(key))){res.writeHead(401).end();return;}
    const item={path:req.url,key,body:JSON.parse(body)};records.push(item);if(records.length>1000)records.shift();await mkdir('.sample',{recursive:true});await appendFile('.sample/capture.ndjson',JSON.stringify(item)+'\n');res.setHeader('Content-Type','application/json');res.end('{}');
  }catch{res.writeHead(400).end();}
});server.listen(port,'127.0.0.1',()=>console.log(`Local OTLP capture http://127.0.0.1:${port}`));
