import type { Context } from '@opentelemetry/api';
import type { AppEnv } from './env';
import type { Telemetry } from './telemetry';
export interface Scenario { phase: 'healthy' | 'regression'; release: string; expires_at: number; source: 'daily' | 'override' | 'baseline' }
export interface Control { phase: string; expires_at: number; release: string }
export function effectiveScenario(env: Pick<AppEnv, 'DEMO_DAILY_START_UTC' | 'DEMO_WINDOW_SECONDS'>, control: Control | null, now = Date.now()): Scenario {
  if (control && control.expires_at > now) return { phase: control.phase === 'regression' ? 'regression' : 'healthy', release: control.release, expires_at: control.expires_at, source: 'override' };
  const date = new Date(now), [hour, minute] = env.DEMO_DAILY_START_UTC.split(':').map(Number);
  let start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour, minute);
  if (start > now && now - (start - 86400000) < Number(env.DEMO_WINDOW_SECONDS) * 1000) start -= 86400000;
  const end = start + Math.min(600, Number(env.DEMO_WINDOW_SECONDS) || 600) * 1000;
  if (now >= start && now < end) return { phase: 'regression', release: `cache-key-v2-${new Date(start).toISOString().slice(0,10)}`, expires_at: end, source: 'daily' };
  return { phase: 'healthy', release: 'cache-key-v1', expires_at: 0, source: 'baseline' };
}
export function validateControl(body: unknown): { phase: string; duration_seconds: number } {
  if (!body || typeof body !== 'object') throw new Error('JSON object required');
  const { phase, duration_seconds } = body as Record<string, unknown>;
  if (!['healthy','regression','recover'].includes(String(phase)) || typeof duration_seconds !== 'number' || !Number.isFinite(duration_seconds) || duration_seconds <= 0 || duration_seconds > 600) throw new Error('phase and finite duration_seconds in (0,600] required');
  return { phase: String(phase), duration_seconds };
}
export async function authorized(request: Request, token?: string) {
  if (!token || token.length < 16) return false;
  const actual = request.headers.get('Authorization') || '';
  const [left, right] = await Promise.all([crypto.subtle.digest('SHA-256', new TextEncoder().encode(actual)), crypto.subtle.digest('SHA-256', new TextEncoder().encode(`Bearer ${token}`))]);
  // Fixed-length digest comparison avoids exposing the control-token length/content.
  const a = new Uint8Array(left), b = new Uint8Array(right); let diff = 0; for (let i=0; i<a.length; i++) diff |= a[i] ^ b[i]; return diff === 0;
}
export async function scenario(env: AppEnv, telemetry: Telemetry, ctx: Context): Promise<Scenario> {
  const control = await env.DB.prepare('SELECT phase, expires_at, release FROM demo_control WHERE id=1').first<Control>();
  const current = effectiveScenario(env, control);
  const previous = await env.DB.prepare('SELECT phase,release FROM demo_events ORDER BY created_at DESC,rowid DESC LIMIT 1').first<{ phase: string; release: string }>();
  if (previous?.phase !== current.phase || previous.release !== current.release) {
    const event = previous?.phase === 'regression' && current.phase === 'healthy' ? `${previous.release}:recovery` : `${current.release}:${current.phase}`;
    await env.DB.prepare('INSERT OR IGNORE INTO demo_events(id,release,phase,created_at) VALUES(?,?,?,?)').bind(event,current.release,current.phase,Date.now()).run();
  }
  // Persist observed transitions separately from accepted delivery. An outage or
  // isolate restart must not permanently suppress a deployment/recovery log.
  const pending = await env.DB.prepare('SELECT e.id,e.release,e.phase,e.created_at FROM demo_events e LEFT JOIN demo_event_delivery d ON d.event_id=e.id WHERE d.event_id IS NULL ORDER BY e.created_at,e.rowid LIMIT 10').all<{ id: string; release: string; phase: string; created_at: number }>();
  for (const event of pending.results) telemetry.durableLog(ctx, event.id, `Simulated ${event.phase === 'regression' ? 'deployment' : 'recovery'}`, { 'event.name': 'deployment', 'demo.simulated': true, 'demo.scenario': 'cache-key-change', 'demo.phase': event.phase, 'demo.release': event.release, 'demo.event.observed_at': new Date(event.created_at).toISOString(), 'service.version': env.SERVICE_VERSION }, async () => {
    await env.DB.prepare('INSERT OR IGNORE INTO demo_event_delivery(event_id,delivered_at) VALUES(?,?)').bind(event.id,Date.now()).run();
  });
  return current;
}
