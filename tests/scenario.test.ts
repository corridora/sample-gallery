import { describe,it,expect,vi } from 'vitest';
import { effectiveScenario,validateControl,authorized,scenario } from '../worker/scenario';
import { Telemetry } from '../worker/telemetry';
import { controlledUrl } from '../worker/index';
import { ROOT_CONTEXT } from '@opentelemetry/api';
import type { AppEnv } from '../worker/env';
const config={DEMO_DAILY_START_UTC:'13:00',DEMO_WINDOW_SECONDS:'600'};
function transitionStore() {
  const rows:{id:string;release:string;phase:string;created_at:number}[]=[{id:'bad:regression',release:'bad',phase:'regression',created_at:1}],delivered=new Set(['bad:regression']);
  const DB={prepare:(sql:string)=>{let values:unknown[]=[];const statement={bind:(...v:unknown[])=>{values=v;return statement;},first:async()=>sql.includes('demo_control')?null:rows.at(-1),all:async()=>({results:rows.filter(row=>!delivered.has(row.id))}),run:async()=>{
    if(sql.includes('INSERT OR IGNORE INTO demo_event_delivery')){delivered.add(String(values[0]));return {meta:{changes:1}};}
    const [id,release,phase,created_at]=values;if(rows.some(row=>row.id===id))return {meta:{changes:0}};rows.push({id:String(id),release:String(release),phase:String(phase),created_at:Number(created_at)});return {meta:{changes:1}};
  }};return statement;}};
  const env={...config,DEMO_DAILY_START_UTC:'00:00',DEMO_WINDOW_SECONDS:'1',SERVICE_VERSION:'actual-build',DB,CORRIDORA_OTLP_ENDPOINT:'http://localhost:4411',CORRIDORA_INGEST_KEY:'mock-key',OTEL_SERVICE_NAME:'sample-gallery-api',OTEL_SERVICE_NAMESPACE:'corridora-samples.gallery',DEPLOYMENT_ENVIRONMENT:'test'} as AppEnv;
  return {rows,delivered,env};
}
describe('scenario and security',()=>{
  it('derives daily UTC fault and expires without a timer',()=>{expect(effectiveScenario(config,null,Date.parse('2026-10-11T13:05:00Z')).phase).toBe('regression');expect(effectiveScenario(config,null,Date.parse('2026-10-11T13:10:00Z')).phase).toBe('healthy');});
  it('expired override cannot extend the regression',()=>{const now=Date.parse('2026-10-11T12:00:00Z');expect(effectiveScenario(config,{phase:'regression',release:'test',expires_at:now-1},now).phase).toBe('healthy');expect(effectiveScenario(config,{phase:'healthy',release:'control',expires_at:now+1},now).source).toBe('override');});
  it('handles daily window crossing midnight',()=>{expect(effectiveScenario({DEMO_DAILY_START_UTC:'23:59',DEMO_WINDOW_SECONDS:'600'},null,Date.parse('2026-10-12T00:03:00Z')).phase).toBe('regression');});
  it.each([0,-1,601,NaN,Infinity,'120',null])('rejects invalid duration %s',duration=>{expect(()=>validateControl({phase:'regression',duration_seconds:duration})).toThrow();});
  it('requires a nonempty sufficiently long control bearer',async()=>{expect(await authorized(new Request('http://localhost'),undefined)).toBe(false);expect(await authorized(new Request('http://localhost',{headers:{Authorization:'Bearer valid-control-token'}}),'valid-control-token')).toBe(true);expect(await authorized(new Request('http://localhost',{headers:{Authorization:'Bearer wrong-control-token'}}),'valid-control-token')).toBe(false);});
  it('allows only explicitly configured HTTPS or local loopback dependencies',()=>{expect(controlledUrl('https://example.com','cloud').origin).toBe('https://example.com');expect(()=>controlledUrl('http://example.com','cloud')).toThrow();expect(()=>controlledUrl('https://user:password@example.com','cloud')).toThrow();expect(controlledUrl('http://127.0.0.1:4107','local').port).toBe('4107');});
  it('persists recovery once across repeated healthy calls',async()=>{
    const {rows,env}=transitionStore();const durableLog=vi.fn(async(_ctx,_id,_body,_attrs,accepted)=>accepted());
    vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-11T12:00:00Z'));try{for(let i=0;i<3;i++)await scenario(env,{durableLog} as unknown as Telemetry,ROOT_CONTEXT);expect(durableLog).toHaveBeenCalledTimes(1);expect(rows.at(-1)?.id).toBe('bad:recovery');}finally{vi.useRealTimers();}
  });
  it('retries a durable transition after failed OTLP export and stops after acceptance',async()=>{
    const {rows,delivered,env}=transitionStore();const exported:string[]=[];let rejectLogs=true;
    vi.stubGlobal('fetch',async(url:string,init:RequestInit)=>{if(new URL(url).pathname==='/v1/logs'){exported.push(String(init.body));return new Response('{}',{status:rejectLogs?503:200});}return new Response('{}');});
    const observed=vi.spyOn(console,'error').mockImplementation(()=>{});
    try{
      const first=new Telemetry(env);await scenario(env,first,ROOT_CONTEXT);await first.flush();expect(delivered.has('bad:recovery')).toBe(false);
      rejectLogs=false;const second=new Telemetry(env);await scenario(env,second,ROOT_CONTEXT);await second.flush();expect(delivered.has('bad:recovery')).toBe(true);
      const third=new Telemetry(env);await scenario(env,third,ROOT_CONTEXT);await third.flush();expect(exported).toHaveLength(2);expect(exported.every(body=>body.includes('bad:recovery'))).toBe(true);expect(rows.filter(row=>row.id==='bad:recovery')).toHaveLength(1);
    }finally{vi.unstubAllGlobals();observed.mockRestore();}
  });
});
