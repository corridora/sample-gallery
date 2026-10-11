import { ROOT_CONTEXT, trace, SpanKind } from '@opentelemetry/api';
import { Telemetry } from './telemetry';
import type { AppEnv } from './env';
export type TrackerEnv = AppEnv & { TRACKER_ALLOWED_ORIGIN?: string };
export async function trackerFetch(request: Request, env: TrackerEnv):Promise<Response>{
  const tel=new Telemetry(env,'sample-gallery-tracker');const span=tel.tracer.startSpan('tracker simulator request',{kind:SpanKind.SERVER},tel.extract(request.headers));const ctx=trace.setSpan(ROOT_CONTEXT,span),url=new URL(request.url);
  try{const headers={'Timing-Allow-Origin':env.TRACKER_ALLOWED_ORIGIN||'http://localhost:4101','Cache-Control':'no-store','Content-Type':'text/javascript'};
    if(url.pathname==='/pixel'){tel.log(ctx,'Simulated pixel failure',{'event.name':'tracker.pixel.failed','demo.simulated':true});return new Response('',{status:503,headers});}
    if(url.pathname==='/healthz')return new Response('ok');
    if(url.pathname!=='/tracker.js')return new Response('Not found',{status:404});
    const bad=url.searchParams.get('mode')==='regression';if(bad)await new Promise(r=>setTimeout(r,1000));
    const pixel=new URL('/pixel',url).href;const code=`(()=>{${bad?'const start=performance.now();while(performance.now()-start<250){}':''}const slot=document.getElementById('ad-slot');if(slot){slot.style.height='${bad?150:80}px';slot.style.background='#d7dfc7';slot.textContent='Controlled advertising simulator';}const pixel=new Image();pixel.src=${JSON.stringify(pixel)};})();`;
    tel.log(ctx,'Controlled tracker delivered',{'demo.simulated':true,'demo.scenario':'tracker','demo.phase':bad?'regression':'healthy'});return new Response(code,{headers});
  }finally{span.end();await tel.flush();}
}
export default {fetch:trackerFetch} satisfies ExportedHandler<TrackerEnv>;
