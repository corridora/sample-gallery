import { chromium, type Page, type APIRequestContext } from '@playwright/test';
import { readFile } from 'node:fs/promises';
const base=process.env.SAMPLE_BASE_URL||'http://localhost:4101';
export async function journey(page: Page, request: APIRequestContext, token: string) {
  if(token.length<16)throw new Error('DEMO_CONTROL_TOKEN required');
  const headers={Authorization:`Bearer ${token}`};
  let connectedTrace='';page.on('response',response=>{if(new URL(response.url()).pathname==='/api/products/demo-product')connectedTrace=response.headers()['x-trace-id']||connectedTrace;});
  async function phase(phase: string,seconds=120){const response=await request.post(`${base}/api/demo/scenario`,{headers,data:{phase,duration_seconds:seconds}});if(!response.ok())throw new Error('Scenario control rejected');}
  try{
    await phase('healthy');
    await page.goto(base);
    // With no configured tag, local workflow-only validation remains useful.
    // A configured but broken SDK must never produce a successful heartbeat.
    const rumConfigured=await page.locator('script[data-service="sample-gallery-web"]').count()>0;
    if(rumConfigured){
      try{await page.waitForFunction(()=>{const w=window as typeof window & {CorridoraRum?:{getInitializationStatus?:()=>string}};return w.CorridoraRum?.getInitializationStatus?.()==='ready';},{},{timeout:10000});}
      catch{throw new Error('Configured Corridora RUM did not become ready; browser incident heartbeat withheld');}
    }
    await page.getByTestId('product-demo-product').waitFor();
    await page.getByTestId('product-demo-product').click();
    await page.getByTestId('status').filter({hasText:'Catalog loaded.'}).waitFor();
    const healthy=Number((await page.getByTestId('elapsed').textContent())?.match(/\d+/)?.[0]);
    await page.getByRole('button',{name:/Prepare image metadata/}).click();
    await page.getByTestId('thumbnail').filter({hasText:'Image metadata ready'}).waitFor({timeout:20000});
    await phase('regression');
    await page.getByTestId('product-demo-product').click();
    await page.getByTestId('status').filter({hasText:'taking longer'}).waitFor();
    const slow=Number((await page.getByTestId('elapsed').textContent())?.match(/\d+/)?.[0]);if(slow<1400)throw new Error(`Regression missing (${slow}ms)`);
    await page.getByTestId('product-healthy-control').click();await page.getByTestId('status').filter({hasText:'Catalog loaded.'}).waitFor();
    const control=Number((await page.getByTestId('elapsed').textContent())?.match(/\d+/)?.[0]);if(control>=1200)throw new Error('Healthy control unexpectedly slow');
    await phase('recover');await page.getByTestId('product-demo-product').click();await page.getByTestId('status').filter({hasText:'Catalog loaded.'}).waitFor();
    // Flush the real RUM provider if loaded. Repeated init returns its existing agent.
    await page.evaluate(async()=>{const w=window as typeof window & {CorridoraRum?:{init:(config:Record<string,unknown>)=>{forceFlush:()=>Promise<void>}}};if(w.CorridoraRum){const script=document.querySelector<HTMLScriptElement>('script[data-service="sample-gallery-web"]');await w.CorridoraRum.init({endpoint:script?.dataset.endpoint,ingestKey:new URL(script!.src).searchParams.get('ckid'),serviceName:'sample-gallery-web'}).forceFlush();}});
    const ids=connectedTrace?{trace_id:connectedTrace}:await(await request.get(`${base}/api/trace-check`)).json();
    const sessionId=await page.evaluate(()=>{try{return JSON.parse(sessionStorage.getItem('corridora.session.v1:sample-gallery-web')||'null')?.id||null;}catch{return null;}});const heartbeat=await request.post(`${base}/api/demo/heartbeat`,{headers,data:{trace_id:ids.trace_id,source:'playwright'}});if(!heartbeat.ok())throw new Error('Heartbeat failed');
    return {healthy_ms:healthy,regression_ms:slow,control_ms:control,trace_id:ids.trace_id,session_id:sessionId,rum:rumConfigured?'ready':'disabled-workflow-only'};
  }finally{await phase('recover',600);}
}
async function main(){
  const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||undefined});
  try{const context=await browser.newContext();const page=await context.newPage();
    if(process.env.RUM_BUNDLE_PATH)await page.route('**/corridora-rum.js*',async route=>route.fulfill({contentType:'text/javascript',body:await readFile(process.env.RUM_BUNDLE_PATH!)}));
    const result=await journey(page,context.request,process.env.DEMO_CONTROL_TOKEN||'');console.log(JSON.stringify(result));
  }finally{await browser.close();}
}
if(process.argv[1]?.endsWith('journey.ts'))void main().catch(error=>{console.error(String(error));process.exitCode=1;});
