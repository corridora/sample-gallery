import { it,expect,vi } from 'vitest';
import { ROOT_CONTEXT,trace,SpanKind } from '@opentelemetry/api';
import { Telemetry } from '../worker/telemetry';
import type { AppEnv } from '../worker/env';
it('serializes real SDK spans/logs/metrics and preserves W3C parentage',async()=>{
  const captured:{path:string;key:string;body:Record<string,any>}[]=[];
  vi.stubGlobal('fetch',async(url:string,init:RequestInit)=>{captured.push({path:new URL(url).pathname,key:new Headers(init.headers).get('X-CORRIDORA-KEY')!,body:JSON.parse(String(init.body))});return new Response('{}');});
  const env={CORRIDORA_OTLP_ENDPOINT:'http://localhost:4319',CORRIDORA_INGEST_KEY:'test-backend-key',OTEL_SERVICE_NAME:'sample-gallery-api',OTEL_SERVICE_NAMESPACE:'corridora-samples.gallery',SERVICE_VERSION:'source-real-build',DEPLOYMENT_ENVIRONMENT:'test',CLOUDFLARE_ACCOUNT_ID:'local'} as AppEnv;
  const tel=new Telemetry(env);const incoming='00-11111111111111111111111111111111-2222222222222222-01';
  const server=tel.tracer.startSpan('SERVER',{kind:SpanKind.SERVER},tel.extract(new Headers({traceparent:incoming})));const ctx=trace.setSpan(ROOT_CONTEXT,server);
  let outbound='';await tel.child(ctx,'CLIENT',SpanKind.CLIENT,{},async child=>{outbound=tel.inject(child).traceparent;tel.log(child,'correlated log',{'demo.scenario':'cache-key-change'});});
  tel.meter.createCounter('test.requests').add(1);server.end();await tel.flush();
  try{expect(captured.map(r=>r.path).sort()).toEqual(['/v1/logs','/v1/metrics','/v1/traces']);expect(captured.every(r=>r.key==='test-backend-key')).toBe(true);
  const traces=captured.find(r=>r.path==='/v1/traces')!.body.resourceSpans[0];const spans=traces.scopeSpans[0].spans;const serverSpan=spans.find((s:Record<string,unknown>)=>s.name==='SERVER'),client=spans.find((s:Record<string,unknown>)=>s.name==='CLIENT');expect(serverSpan.traceId).toBe('11111111111111111111111111111111');expect(serverSpan.parentSpanId).toBe('2222222222222222');expect(client.parentSpanId).toBe(serverSpan.spanId);expect(outbound).toContain(client.spanId);expect(traces.resource.attributes.find((a:{key:string})=>a.key==='service.version').value.stringValue).toBe('source-real-build');
  const record=captured.find(r=>r.path==='/v1/logs')!.body.resourceLogs[0].scopeLogs[0].logRecords[0];expect(record.traceId).toBe(client.traceId);expect(record.spanId).toBe(client.spanId);expect(captured.find(r=>r.path==='/v1/metrics')!.body.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0].asDouble).toBe(1);
  }finally{vi.unstubAllGlobals();}
});
