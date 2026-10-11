import { it,expect } from 'vitest';
import { trackerFetch,type TrackerEnv } from '../worker/tracker';
const env={CORRIDORA_OTLP_ENDPOINT:'',OTEL_SERVICE_NAME:'sample-gallery-tracker',OTEL_SERVICE_NAMESPACE:'corridora-samples.gallery',SERVICE_VERSION:'actual-source',DEPLOYMENT_ENVIRONMENT:'test',CLOUDFLARE_ACCOUNT_ID:'local',TRACKER_ALLOWED_ORIGIN:'http://localhost:4101'} as TrackerEnv;
it('controlled tracker publishes bounded task and timing access; pixel failure is observable',async()=>{
  const response=await trackerFetch(new Request('http://localhost:4108/tracker.js?mode=regression'),env);
  expect(response.headers.get('Timing-Allow-Origin')).toBe('http://localhost:4101');const js=await response.text();expect(js).toContain('performance.now()-start<250');expect(js).toContain("slot.style.height='150px'");
  expect((await trackerFetch(new Request('http://localhost:4108/pixel'),env)).status).toBe(503);
});
