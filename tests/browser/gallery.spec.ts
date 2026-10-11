import { test,expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { journey } from '../../scripts/journey';
test('seeded gallery, actual queue, healthy → regression → recovery and captured correlation',async({page,request})=>{
  const local=!process.env.SAMPLE_BASE_URL;const token=local?'local-test-control-token-32-chars':process.env.DEMO_CONTROL_TOKEN||'';
  if(process.env.RUM_BUNDLE_PATH)await page.route('**/corridora-rum.js*',async route=>route.fulfill({contentType:'text/javascript',body:await readFile(process.env.RUM_BUNDLE_PATH!)}));
  const result=await journey(page,request,token);expect(result.regression_ms).toBeGreaterThanOrEqual(1400);console.log('Journey evidence',JSON.stringify(result));
  if(local){const records=await(await request.get('http://127.0.0.1:4411/records')).json();const backend=records.filter((r:{key:string})=>r.key==='test-backend-key');for(const signal of ['traces','logs','metrics'])expect(backend.some((r:{path:string})=>r.path===`/v1/${signal}`)).toBeTruthy();
    const spans=(key:string)=>records.filter((r:{key:string;path:string})=>r.key===key&&r.path.startsWith('/v1/traces')).flatMap((r:{body:{resourceSpans:{scopeSpans:{spans:unknown[]}[]}[]}})=>r.body.resourceSpans.flatMap(resource=>resource.scopeSpans.flatMap(scope=>scope.spans)));
    const workerSpans=spans('test-backend-key');const producer=workerSpans.find((s:{kind:number})=>s.kind===4);const consumer=workerSpans.find((s:{kind:number})=>s.kind===5);expect(producer,'Actual Queues PRODUCER span').toBeTruthy();expect(consumer,'Actual Queues CONSUMER span').toBeTruthy();expect(consumer.traceId).toBe(producer.traceId);expect(consumer.parentSpanId).toBe(producer.spanId);
    if(process.env.RUM_BUNDLE_PATH){const clients=spans('test-browser-key').filter((s:{kind:number})=>s.kind===3);const servers=spans('test-backend-key').filter((s:{kind:number})=>s.kind===2);expect(clients.length).toBeGreaterThan(0);expect(spans('test-browser-key').some((s:{name:string})=>s.name==='gallery.select_product')).toBeTruthy();const linked=servers.find((server:{traceId:string;parentSpanId:string})=>clients.some((client:{traceId:string;spanId:string})=>client.traceId===server.traceId&&client.spanId===server.parentSpanId));expect(linked,'Actual RUM CLIENT span must be the SERVER parent').toBeTruthy();console.log('Captured real RUM → Worker parentage',JSON.stringify(linked));}
    else console.log('RUM_BUNDLE_PATH unset: browser symptoms and backend export verified; RUM correlation not asserted.');
  }
});

test('control authentication, strict duration and auto-expiry',async({request})=>{
  const base=process.env.SAMPLE_BASE_URL||'http://localhost:4101';const token=process.env.SAMPLE_BASE_URL?process.env.DEMO_CONTROL_TOKEN!:'local-test-control-token-32-chars';
  expect((await request.post(base+'/api/demo/scenario',{data:{phase:'regression',duration_seconds:1}})).status()).toBe(401);
  const headers={Authorization:`Bearer ${token}`};expect((await request.post(base+'/api/demo/scenario',{headers,data:{phase:'regression',duration_seconds:601}})).status()).toBe(400);
  const control=await(await request.post(base+'/api/demo/scenario',{headers,data:{phase:'regression',duration_seconds:.1}})).json();
  await new Promise(resolve=>setTimeout(resolve,250));const status=await(await request.get(base+'/api/demo/status')).json();expect(status.release).not.toBe(control.release);expect(status.source).not.toBe('override');
});

test('configured broken RUM prevents a browser heartbeat',async({page,request})=>{
  const base=process.env.SAMPLE_BASE_URL||'http://localhost:4101';const token=process.env.SAMPLE_BASE_URL?process.env.DEMO_CONTROL_TOKEN!:'local-test-control-token-32-chars';
  const before=await(await request.get(base+'/api/demo/heartbeat')).json();
  await page.route('**/corridora-rum.js*',route=>route.abort());
  await page.route(base+'/',async route=>{const response=await route.fetch();let html=await response.text();html=html.replace(/<script\b[^>]*data-service="sample-gallery-web"[^>]*><\/script>/g,'');html=html.replace('<head>','<head><script data-service="sample-gallery-web" src="/corridora-rum.js?ckid=broken-test"></script>');await route.fulfill({response,body:html});});
  await expect(journey(page,request,token)).rejects.toThrow('Configured Corridora RUM did not become ready');
  expect(await(await request.get(base+'/api/demo/heartbeat')).json()).toEqual(before);
});
