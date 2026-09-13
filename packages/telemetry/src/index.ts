import { SpanStatusCode } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
  type SpanExporter,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import { MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics';
export type LogSink = (record: Readonly<Record<string, unknown>>) => void;
class SafeSpanExporter implements SpanExporter {
  constructor(private readonly sink: LogSink) {}
  export(spans: ReadableSpan[], done: (result: { code: 0 | 1 }) => void) {
    for (const span of spans)
      this.sink({
        event: 'trace',
        traceId: span.spanContext().traceId,
        spanId: span.spanContext().spanId,
        name: span.name,
        status: span.status.code,
      });
    done({ code: 0 });
  }
  shutdown() {
    return Promise.resolve();
  }
}
class OnDemandReader extends MetricReader {
  protected onShutdown() {
    return Promise.resolve();
  }
  protected onForceFlush() {
    return this.collect().then(() => undefined);
  }
}
export class FoundationTelemetry {
  readonly reader = new OnDemandReader({ cardinalitySelector: () => 32 });
  private readonly metrics = new MeterProvider({ readers: [this.reader] });
  private readonly traces: BasicTracerProvider;
  private readonly meter = this.metrics.getMeter('rpt.foundation', '1.0.0');
  private readonly latency = this.meter.createHistogram('rpt.request.duration', { unit: 'ms' });
  private readonly requests = this.meter.createCounter('rpt.request.count');
  private readonly failures = this.meter.createCounter('rpt.failure.count');
  constructor(
    private readonly sink: LogSink = (record) => console.log(JSON.stringify(record)),
    exporter?: SpanExporter,
  ) {
    this.traces = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter ?? new SafeSpanExporter(sink))],
    });
  }
  async request<T extends { status: number }>(
    requestId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const start = performance.now();
    const span = this.traces.getTracer('rpt.foundation', '1.0.0').startSpan('foundation.request');
    let status = 503;
    try {
      const result = await operation();
      status = result.status;
      return result;
    } finally {
      const durationMs = performance.now() - start;
      const statusClass = `${Math.floor(status / 100)}xx`;
      this.latency.record(durationMs, { statusClass });
      this.requests.add(1, { statusClass });
      if (status >= 400)
        this.failures.add(1, {
          category:
            status === 401
              ? 'auth'
              : status === 404
                ? 'permission'
                : status >= 500
                  ? 'dependency'
                  : 'validation',
        });
      span.setStatus({ code: status >= 500 ? SpanStatusCode.ERROR : SpanStatusCode.OK });
      span.end();
      this.sink({
        event: 'request',
        requestId,
        traceId: span.spanContext().traceId,
        status,
        durationMs: Math.round(durationMs),
      });
    }
  }
  async flush() {
    await this.traces.forceFlush();
    const result = await this.reader.collect();
    this.sink({ event: 'otel_metrics', resourceMetrics: result.resourceMetrics });
  }
  async shutdown() {
    await this.traces.shutdown();
    await this.metrics.shutdown();
  }
}
