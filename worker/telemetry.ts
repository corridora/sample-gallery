import { ROOT_CONTEXT, trace, SpanKind, SpanStatusCode, type Context, type Attributes } from '@opentelemetry/api';
import { W3CTraceContextPropagator, ExportResultCode, type ExportResult } from '@opentelemetry/core';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BasicTracerProvider, BatchSpanProcessor, type SpanExporter, type ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { LoggerProvider, BatchLogRecordProcessor, type LogRecordExporter, type ReadableLogRecord } from '@opentelemetry/sdk-logs';
import { MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics';
import { JsonTraceSerializer, JsonLogsSerializer, JsonMetricsSerializer } from '@opentelemetry/otlp-transformer';
import type { AppEnv } from './env';

export const propagator = new W3CTraceContextPropagator();
export const headerGetter = { keys: (h: Headers) => [...h.keys()], get: (h: Headers, k: string) => h.get(k) ?? undefined };
export const carrierSetter = { set: (c: Record<string, string>, k: string, v: string) => { c[k] = v; } };
export async function sendJson(env: Pick<AppEnv, 'CORRIDORA_OTLP_ENDPOINT' | 'CORRIDORA_INGEST_KEY'>, signal: string, body: Uint8Array | undefined): Promise<void> {
  if (!env.CORRIDORA_OTLP_ENDPOINT || !env.CORRIDORA_INGEST_KEY || !body) return;
  const response = await fetch(`${env.CORRIDORA_OTLP_ENDPOINT.replace(/\/$/, '')}/v1/${signal}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CORRIDORA-KEY': env.CORRIDORA_INGEST_KEY },
    body: new TextDecoder().decode(body), signal: AbortSignal.timeout(2000), redirect: 'manual'
  });
  if (!response.ok) throw new Error(`OTLP ${signal} HTTP ${response.status}`);
  // Export failures are observable through native console logs; never recursively instrument this fetch.
}
class TraceExporter implements SpanExporter {
  constructor(private env: AppEnv) {}
  export(spans: ReadableSpan[], done: (r: ExportResult) => void) { void sendJson(this.env, 'traces', JsonTraceSerializer.serializeRequest(spans)).then(() => done({ code: ExportResultCode.SUCCESS }), error => { console.error(JSON.stringify({ event: 'telemetry.export.failed', signal: 'traces', error: String(error) })); done({ code: ExportResultCode.FAILED, error }); }); }
  async shutdown() {}
}
class LogExporter implements LogRecordExporter {
  async forceFlush() {}
  constructor(private env: AppEnv, private accepted: (records: ReadableLogRecord[]) => Promise<void>) {}
  export(records: ReadableLogRecord[], done: (r: ExportResult) => void) { void (async () => {
    await sendJson(this.env, 'logs', JsonLogsSerializer.serializeRequest(records));
    if (this.env.CORRIDORA_OTLP_ENDPOINT && this.env.CORRIDORA_INGEST_KEY) await this.accepted(records);
  })().then(() => done({ code: ExportResultCode.SUCCESS }), error => { console.error(JSON.stringify({ event: 'telemetry.export.failed', signal: 'logs', error: String(error) })); done({ code: ExportResultCode.FAILED, error }); }); }
  async shutdown() {}
}
class LifecycleMetricReader extends MetricReader {
  constructor(private env: AppEnv) { super(); }
  protected async onForceFlush() { const { resourceMetrics } = await this.collect(); await sendJson(this.env, 'metrics', JsonMetricsSerializer.serializeRequest(resourceMetrics)); }
  protected async onShutdown() {}
}
export class Telemetry {
  private readonly pendingLogs = new Map<string, () => Promise<void>>();
  readonly traces: BasicTracerProvider;
  readonly logs: LoggerProvider;
  readonly metrics: MeterProvider;
  readonly tracer;
  readonly meter;
  constructor(readonly env: AppEnv, service = env.OTEL_SERVICE_NAME) {
    const resource = resourceFromAttributes({ 'service.name': service, 'service.namespace': env.OTEL_SERVICE_NAMESPACE, 'service.version': env.SERVICE_VERSION,
      'deployment.environment.name': env.DEPLOYMENT_ENVIRONMENT, 'cloud.provider': 'cloudflare', 'cloud.platform': 'cloudflare_workers',
      'cloud.account.id': env.CLOUDFLARE_ACCOUNT_ID || 'local', 'cloud.resource_id': `workers/${service}` });
    this.traces = new BasicTracerProvider({ resource, spanProcessors: [new BatchSpanProcessor(new TraceExporter(env), { scheduledDelayMillis: 60000, maxQueueSize: 128, maxExportBatchSize: 128, exportTimeoutMillis: 2500 })] });
    this.logs = new LoggerProvider({ resource, processors: [new BatchLogRecordProcessor({ exporter: new LogExporter(env, async records => {
      for (const record of records) {
        const id = String(record.attributes['demo.event.id'] || ''), acknowledge = this.pendingLogs.get(id);
        if (acknowledge) { await acknowledge(); this.pendingLogs.delete(id); }
      }
    }), scheduledDelayMillis: 60000, exportTimeoutMillis: 2500 })] });
    this.metrics = new MeterProvider({ resource, readers: [new LifecycleMetricReader(env)] });
    this.tracer = this.traces.getTracer('sample-gallery', '1.0.0'); this.meter = this.metrics.getMeter('sample-gallery');
  }
  extract(headers: Headers) { return propagator.extract(ROOT_CONTEXT, headers, headerGetter); }
  inject(ctx: Context) { const headers: Record<string, string> = {}; propagator.inject(ctx, headers, carrierSetter); return headers; }
  log(ctx: Context, body: string, attributes: Attributes = {}) { this.logs.getLogger('sample-gallery').emit({ body, severityNumber: 9, severityText: 'INFO', context: ctx, attributes }); }
  durableLog(ctx: Context, id: string, body: string, attributes: Attributes, accepted: () => Promise<void>) {
    if (this.pendingLogs.has(id)) return;
    this.pendingLogs.set(id, accepted);
    this.log(ctx, body, { ...attributes, 'demo.event.id': id });
  }
  async child<T>(ctx: Context, name: string, kind: SpanKind, attributes: Attributes, action: (child: Context) => Promise<T>): Promise<T> {
    const span = this.tracer.startSpan(name, { kind, attributes }, ctx); const child = trace.setSpan(ctx, span);
    try { return await action(child); } catch (error) { span.recordException(error instanceof Error ? error : String(error)); span.setStatus({ code: SpanStatusCode.ERROR }); throw error; } finally { span.end(); }
  }
  async flush() {
    try { await Promise.all([this.traces.forceFlush(), this.logs.forceFlush(), this.metrics.forceFlush({ timeoutMillis: 2500 })]); }
    catch (error) { console.error(JSON.stringify({ event: 'telemetry.flush.failed', error: String(error) })); }
    finally { await Promise.all([this.traces.shutdown(), this.logs.shutdown(), this.metrics.shutdown()]); }
  }
}
