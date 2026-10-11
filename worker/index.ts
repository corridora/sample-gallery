import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { ROOT_CONTEXT, trace, SpanKind, SpanStatusCode, type Context } from '@opentelemetry/api';
import { Telemetry } from './telemetry';
import { authorized, scenario, validateControl, type Scenario } from './scenario';
import type { AppEnv } from './env';
interface Product { id: string; name: string; description: string; price: number; image_key: string }
interface ThumbnailMessage { job_id: string; product_id: string; image_key: string; trace: Record<string,string>; expires_at: number }
type Variables = { telemetry: Telemetry; parent: Context; scenario: Scenario };
export const app = new Hono<{ Bindings: AppEnv; Variables: Variables }>();
app.use('/api/demo/*',bodyLimit({maxSize:1024}));
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const htmlEscape = (v: string) => v.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function controlledUrl(value: string, mode: string): URL {
  const url = new URL(value); if (url.username || url.password || (url.protocol !== 'https:' && !(mode === 'local' && url.protocol === 'http:' && ['localhost','127.0.0.1'].includes(url.hostname)))) throw new Error('Controlled dependency requires HTTPS (local loopback allowed)'); return url;
}
app.use('*', async (c, next) => {
  if (!c.req.path.startsWith('/api/') && c.req.path !== '/healthz') return next();
  const tel = new Telemetry(c.env); const span = tel.tracer.startSpan(`${c.req.method} ${c.req.path.replace(/\/products\/[^/]+$/, '/products/:id')}`, { kind: SpanKind.SERVER, attributes: { 'http.request.method': c.req.method, 'url.path': c.req.path } }, tel.extract(c.req.raw.headers));
  const parent = trace.setSpan(ROOT_CONTEXT, span), started = Date.now(); c.set('telemetry', tel); c.set('parent', parent);
  try { const current = await scenario(c.env, tel, parent); c.set('scenario', current); span.setAttributes({ 'demo.scenario': 'cache-key-change', 'demo.phase': current.phase, 'demo.release': current.release }); await next(); span.setAttribute('http.response.status_code', c.res.status); if (c.res.status >= 500) span.setStatus({code:SpanStatusCode.ERROR}); }
  catch (error) { span.recordException(error instanceof Error ? error : String(error)); span.setStatus({ code: SpanStatusCode.ERROR }); c.res = c.json({ error: 'Request failed; inspect correlated telemetry' }, 500); }
  finally {
    c.header('Cache-Control','no-store'); c.header('X-Trace-Id',span.spanContext().traceId); c.header('X-Span-Id',span.spanContext().spanId);
    tel.log(parent,'Gallery request completed',{ 'http.response.status_code':c.res.status, 'demo.scenario':'cache-key-change','demo.phase':c.get('scenario')?.phase || 'unknown' });
    tel.meter.createHistogram('gallery.request.duration', { unit:'ms' }).record(Date.now()-started, {'http.route': c.req.path.startsWith('/api/products/')?'/api/products/:id':c.req.path,'demo.scenario':'cache-key-change','demo.phase':c.get('scenario')?.phase || 'unknown'});
    span.end(); await tel.flush();
  }
});
app.get('/healthz', c => c.json({ status:'ok',service:c.env.OTEL_SERVICE_NAME,version:c.env.SERVICE_VERSION,telemetry:c.env.CORRIDORA_OTLP_ENDPOINT && c.env.CORRIDORA_INGEST_KEY?'configured':'disabled' }));
app.get('/api/trace-check', c => { const ids=trace.getSpan(c.get('parent'))!.spanContext(); return c.json({trace_id:ids.traceId,span_id:ids.spanId}); });
app.get('/api/demo/status', c => c.json({...c.get('scenario'),service_version:c.env.SERVICE_VERSION,scenario:'cache-key-change'}));
app.get('/api/config', c => c.json({ tracker_simulator_url:c.env.TRACKER_SIMULATOR_URL, real_trackers_enabled:false }));
app.post('/api/demo/scenario', async c => {
  if (!await authorized(c.req.raw,c.env.DEMO_CONTROL_TOKEN)) return c.json({error:'Unauthorized'},401);
  let control; try { control=validateControl(await c.req.json()); } catch(error) { return c.json({error:String(error)},400); }
  const release=`cache-key-${control.phase==='regression'?'v2':'v1'}-override-${crypto.randomUUID()}`;
  const expires=Date.now()+control.duration_seconds*1000;
  await c.env.DB.prepare('INSERT INTO demo_control(id,phase,expires_at,release) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET phase=excluded.phase,expires_at=excluded.expires_at,release=excluded.release').bind(control.phase,expires,release).run();
  c.get('telemetry').log(c.get('parent'),'Simulated feature flag updated',{'event.name':'feature_flag','demo.simulated':true,'demo.scenario':'cache-key-change','demo.phase':control.phase,'demo.release':release,'service.version':c.env.SERVICE_VERSION});
  return c.json({phase:control.phase,expires_at:expires,release});
});
app.get('/api/products', async c => {
  const result=await c.get('telemetry').child(c.get('parent'),'D1 catalog list',SpanKind.CLIENT,{'db.system.name':'sqlite','db.namespace':'catalog'},()=>c.env.DB.prepare('SELECT * FROM products ORDER BY id').all<Product>());
  return c.json({items:result.results});
});
app.get('/api/products/:id', async c => {
  const id=c.req.param('id'), tel=c.get('telemetry'), ctx=c.get('parent'), current=c.get('scenario');
  const product=await tel.child(ctx,'D1 catalog detail',SpanKind.CLIENT,{'db.system.name':'sqlite'},()=>c.env.DB.prepare('SELECT * FROM products WHERE id=?').bind(id).first<Product>());
  if(!product) return c.json({error:'Product not found'},404);
  const bad=current.phase==='regression' && id==='demo-product';
  await tel.child(ctx,'KV catalog policy',SpanKind.CLIENT,{'db.system.name':'cloudflare_kv'},()=>c.env.CONFIG.get('catalog-policy'));
  let lookups=0;
  await tel.child(ctx,'catalog image lookups',SpanKind.INTERNAL,{'demo.simulated':bad,'cache.key.revision':bad?'v2-request-varying':'v1-stable'},async child=>{
    // Cache only internal metadata. API responses themselves remain no-store.
    const key=new Request(new URL(`/__catalog_cache/${product.id}`,c.req.url));
    const cached=bad?undefined:await caches.default.match(key);
    trace.getSpan(child)?.setAttribute('cache.hit',Boolean(cached));
    if(!cached){let metadata:R2Object|null=null;
      for(let i=0;i<(bad?3:1);i++){metadata=await tel.child(child,'R2 image metadata',SpanKind.CLIENT,{'db.system.name':'cloudflare_r2'},()=>c.env.IMAGES.head(product.image_key));lookups++;}
      if(!bad&&metadata)await caches.default.put(key,new Response(JSON.stringify({bytes:metadata.size}),{headers:{'Cache-Control':'public, max-age=60','Content-Type':'application/json'}}));
    }
    if(bad) await wait(1500);
  });
  tel.meter.createCounter('gallery.catalog.lookups').add(lookups,{'demo.phase':current.phase});
  return c.json({product,scenario:current.phase,release:current.release,lookup_count:lookups});
});
app.get('/api/images/:key', async c => {
  if(!['orbit.svg','fern.svg','clock.svg'].includes(c.req.param('key'))) return c.notFound();
  const object=await c.get('telemetry').child(c.get('parent'),'R2 get image',SpanKind.CLIENT,{'db.system.name':'cloudflare_r2'},()=>c.env.IMAGES.get(c.req.param('key')));
  if(!object) return c.notFound();
  return new Response(object.body,{headers:{'Content-Type':'image/svg+xml','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
});
app.get('/api/recommendations',async c=>{
  const tel=c.get('telemetry'),ctx=c.get('parent');
  if(!c.env.RECOMMENDER_URL) return c.json({items:[{id:'healthy-control',score:.9}],model_revision:'fixture-v1',source:'local-fixture'});
  try { const url=controlledUrl(c.env.RECOMMENDER_URL,c.env.SAMPLE_MODE); url.pathname='/api/recommendations'; url.search='?product_id=demo-product';
    const result=await tel.child(ctx,'GET recommender',SpanKind.CLIENT,{'server.address':url.hostname,'cloud.destination':'gcp'},async child=>{
      const headers=tel.inject(child);if(c.env.DOWNSTREAM_AUTH_TOKEN) headers.Authorization=`Bearer ${c.env.DOWNSTREAM_AUTH_TOKEN}`;
      const response=await fetch(url,{headers,signal:AbortSignal.timeout(2000),redirect:'manual'});if(!response.ok) throw new Error(`Dependency HTTP ${response.status}`);
      if(Number(response.headers.get('Content-Length')||0)>65536) throw new Error('Dependency response too large');
      const reader=response.body?.getReader();if(!reader) throw new Error('Empty dependency response');let size=0,text='';const decoder=new TextDecoder();for(;;){const part=await reader.read();if(part.done) break;size+=part.value.byteLength;if(size>65536){await reader.cancel();throw new Error('Dependency response too large');}text+=decoder.decode(part.value,{stream:true});} const data=JSON.parse(text);if(!Array.isArray(data.items))throw new Error('Invalid recommendation contract');return data;
    });return c.json(result);
  } catch { tel.log(ctx,'Recommender fallback used',{'event.name':'dependency.fallback'});return c.json({items:[{id:'healthy-control',score:.8}],model_revision:'fixture-v1',source:'bounded-fallback'}); }
});
app.post('/api/products/:id/thumbnail',async c=>{
  const product=await c.env.DB.prepare('SELECT * FROM products WHERE id=?').bind(c.req.param('id')).first<Product>();if(!product)return c.notFound();
  const jobId=`thumb-${product.id}`,insert=await c.env.DB.prepare('INSERT OR IGNORE INTO thumbnail_jobs(id,product_id,status) VALUES(?,?,?)').bind(jobId,product.id,'queued').run();
  if(insert.meta.changes) await c.get('telemetry').child(c.get('parent'),'Queues publish thumbnail',SpanKind.PRODUCER,{'messaging.system':'cloudflare_queues','messaging.destination.name':'thumbnails'},async child=>c.env.THUMBNAILS.send({job_id:jobId,product_id:product.id,image_key:product.image_key,trace:c.get('telemetry').inject(child),expires_at:Date.now()+600000} satisfies ThumbnailMessage));
  return c.json({id:jobId,status:'queued'},202);
});
app.get('/api/thumbnails/:id',async c=>{const job=await c.env.DB.prepare('SELECT * FROM thumbnail_jobs WHERE id=?').bind(c.req.param('id')).first();return job?c.json(job):c.notFound();});
app.post('/api/demo/heartbeat',async c=>{
  if(!await authorized(c.req.raw,c.env.DEMO_CONTROL_TOKEN)) return c.json({error:'Unauthorized'},401);
  const body=await c.req.json<{trace_id?:string;source?:string}>();if(!/^[a-f0-9]{32}$/.test(body.trace_id||''))return c.json({error:'trace_id required'},400);
  await c.env.DB.prepare('INSERT OR REPLACE INTO heartbeats(day,completed_at,trace_id,source) VALUES(?,?,?,?)').bind(new Date().toISOString().slice(0,10),Date.now(),body.trace_id,String(body.source||'browser').slice(0,40)).run();
  return c.json({recorded:true});
});
app.get('/api/demo/heartbeat',async c=>c.json(await c.env.DB.prepare('SELECT * FROM heartbeats ORDER BY day DESC LIMIT 1').first() || {completed_at:0}));
app.all('/api/*', c=>c.json({error:'Not found'},404));
app.all('*', async c=>{
  const response=await c.env.ASSETS.fetch(c.req.raw);
  if(!response.headers.get('content-type')?.includes('text/html')) return response;
  const origin=new URL(c.req.url).origin,rum=c.env.CORRIDORA_RUM_KEY?new URL(c.env.CORRIDORA_RUM_SCRIPT_URL):null;
  if(rum)rum.searchParams.set('ckid',c.env.CORRIDORA_RUM_KEY);
  const tag=rum?`<script src="${htmlEscape(rum.href)}" data-endpoint="${htmlEscape(c.env.CORRIDORA_OTLP_ENDPOINT)}" data-service="sample-gallery-web" data-service-namespace="${htmlEscape(c.env.OTEL_SERVICE_NAMESPACE)}" data-env="${htmlEscape(c.env.DEPLOYMENT_ENVIRONMENT)}" data-version="${htmlEscape(c.env.SERVICE_VERSION)}" data-trace-sample-rate="1" data-long-tasks="true" data-trace-origins="${htmlEscape(origin)}"></script>`:'';
  const output=new HTMLRewriter().on('head',{element(el){el.prepend(tag,{html:true});}}).transform(response);
  const headers=new Headers(output.headers);headers.set('Cache-Control','no-store');
  const ingest=c.env.CORRIDORA_OTLP_ENDPOINT?new URL(c.env.CORRIDORA_OTLP_ENDPOINT).origin:'';const tracker=c.env.TRACKER_SIMULATOR_URL?new URL(c.env.TRACKER_SIMULATOR_URL).origin:'';
  headers.set('Content-Security-Policy',`default-src 'self'; script-src 'self' 'unsafe-inline' ${rum?.origin||''} ${tracker}; connect-src 'self' ${ingest} ${tracker}; img-src 'self' data: ${tracker}; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'`);
  return new Response(output.body,{status:output.status,headers});
});
export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<ThumbnailMessage>, env: AppEnv) {
    const tel=new Telemetry(env,'sample-gallery-worker');
    try {for(const message of batch.messages){const parent=tel.extract(new Headers(message.body.trace));await tel.child(parent,'thumbnail consume',SpanKind.CONSUMER,{'messaging.system':'cloudflare_queues','messaging.message.id':message.id},async ctx=>{
      await scenario(env,tel,ctx);
      if(message.body.expires_at<=Date.now()){tel.log(ctx,'Expired thumbnail discarded',{'event.name':'queue.expired'});message.ack();return;}
      try{const object=await tel.child(ctx,'R2 thumbnail source',SpanKind.CLIENT,{'db.system.name':'cloudflare_r2'},()=>env.IMAGES.head(message.body.image_key));if(!object)throw new Error('Missing seeded image');
      const metadata=JSON.stringify({source:message.body.image_key,width:640,height:480,bytes:object.size,generated_at:new Date().toISOString()});
      await env.IMAGES.put(`thumbnails/${message.body.product_id}.json`,metadata,{httpMetadata:{contentType:'application/json'}});
      await env.DB.prepare('UPDATE thumbnail_jobs SET status=?,metadata=? WHERE id=?').bind('ready',metadata,message.body.job_id).run();tel.log(ctx,'Thumbnail metadata ready',{'event.name':'thumbnail.ready'});message.ack();
      }catch(error){tel.log(ctx,'Thumbnail retry',{'event.name':'queue.retry','retry.count':message.attempts});message.retry({delaySeconds:3});}
    });}}finally{await tel.flush();}
  },
  async scheduled(event: ScheduledController,env: AppEnv,ctx: ExecutionContext){
    // UTC derivation in each request remains authoritative when Cron is delayed.
    const tel=new Telemetry(env,'sample-gallery-worker');const span=tel.tracer.startSpan('daily scheduler');const parent=trace.setSpan(ROOT_CONTEXT,span);
    try{const current=await scenario(env,tel,parent);if(env.ENABLE_SYNTHETICS==='true' && current.phase==='regression'){
      const p=await env.DB.prepare('SELECT image_key FROM products WHERE id=?').bind('demo-product').first<{image_key:string}>();
      if(p){await tel.child(parent,'cron cache regression probe',SpanKind.INTERNAL,{'demo.simulated':true},async child=>{for(let i=0;i<3;i++)await tel.child(child,'R2 image metadata',SpanKind.CLIENT,{},()=>env.IMAGES.head(p.image_key));await wait(1500);});tel.log(parent,'Daily backend probe completed; browser heartbeat remains required',{'event.name':'demo.probe'});}}
    }finally{span.end();ctx.waitUntil(tel.flush());}
  }
} satisfies ExportedHandler<AppEnv,ThumbnailMessage>;
