import { createServer } from 'node:http';
import { trackerFetch } from '../worker/tracker';
import type { TrackerEnv } from '../worker/tracker';
const env={...process.env,OTEL_SERVICE_NAME:'sample-gallery-tracker',OTEL_SERVICE_NAMESPACE:'corridora-samples.gallery',SERVICE_VERSION:'local',DEPLOYMENT_ENVIRONMENT:'development',CORRIDORA_OTLP_ENDPOINT:process.env.CORRIDORA_OTLP_ENDPOINT||'',CLOUDFLARE_ACCOUNT_ID:'local'} as TrackerEnv;
createServer(async(req,res)=>{const response=await trackerFetch(new Request('http://localhost:4108'+req.url,{headers:req.headers as Record<string,string>}),env);res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());}).listen(4108,'127.0.0.1',()=>console.log('Controlled tracker http://localhost:4108/tracker.js?mode=regression'));
