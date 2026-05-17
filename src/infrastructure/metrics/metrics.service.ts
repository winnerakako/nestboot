import { Injectable, Logger } from '@nestjs/common';

/**
 * Lightweight in-process metrics collection.
 * No external dependencies — collects counters, gauges, and histograms
 * and exposes them via the /metrics endpoint in a simple text format.
 *
 * Usage:
 *   this.metrics.increment('http_requests_total', { method: 'GET', path: '/api/users' });
 *   this.metrics.gauge('websocket_connections', count);
 *   this.metrics.histogram('http_duration_ms', durationMs, { path: '/api/users' });
 */

interface MetricEntry {
  name: string;
  type: 'counter' | 'gauge' | 'histogram';
  help?: string;
}

interface CounterValue {
  value: number;
  labels: Record<string, string>;
}

interface GaugeValue {
  value: number;
  labels: Record<string, string>;
}

interface HistogramValue {
  count: number;
  sum: number;
  buckets: number[];
  labels: Record<string, string>;
}

const DEFAULT_HISTOGRAM_BUCKETS = [
  1,
  5,
  10,
  25,
  50,
  100,
  250,
  500,
  1000,
  2500,
  5000,
  10000,
  Number.POSITIVE_INFINITY,
];

@Injectable()
export class MetricsService {
  private readonly logger = new Logger(MetricsService.name);
  private readonly counters = new Map<string, CounterValue[]>();
  private readonly gauges = new Map<string, GaugeValue[]>();
  private readonly histograms = new Map<string, HistogramValue[]>();
  private readonly metadata = new Map<string, MetricEntry>();

  /**
   * Register a metric with a help description.
   * Optional — metrics are auto-registered on first use.
   */
  register(
    name: string,
    type: 'counter' | 'gauge' | 'histogram',
    help?: string,
  ) {
    const metricName = this.normalizeMetricName(name);
    this.metadata.set(metricName, { name: metricName, type, help });
  }

  /**
   * Increment a counter. Creates the counter if it doesn't exist.
   */
  increment(name: string, labels: Record<string, string> = {}, value = 1) {
    const metricName = this.normalizeMetricName(name);
    if (!this.metadata.has(metricName)) {
      this.metadata.set(metricName, { name: metricName, type: 'counter' });
    }

    const entries = this.counters.get(metricName) || [];
    const existing = entries.find((e) => this.labelsMatch(e.labels, labels));

    if (existing) {
      existing.value += value;
    } else {
      entries.push({ value, labels });
      this.counters.set(metricName, entries);
    }
  }

  /**
   * Set a gauge to a specific value. Creates the gauge if it doesn't exist.
   */
  gauge(name: string, value: number, labels: Record<string, string> = {}) {
    const metricName = this.normalizeMetricName(name);
    if (!this.metadata.has(metricName)) {
      this.metadata.set(metricName, { name: metricName, type: 'gauge' });
    }

    const entries = this.gauges.get(metricName) || [];
    const existing = entries.find((e) => this.labelsMatch(e.labels, labels));

    if (existing) {
      existing.value = value;
    } else {
      entries.push({ value, labels });
      this.gauges.set(metricName, entries);
    }
  }

  /**
   * Record a histogram observation (e.g., latency, size).
   */
  histogram(name: string, value: number, labels: Record<string, string> = {}) {
    const metricName = this.normalizeMetricName(name);
    if (!this.metadata.has(metricName)) {
      this.metadata.set(metricName, { name: metricName, type: 'histogram' });
    }

    const entries = this.histograms.get(metricName) || [];
    const existing = entries.find((e) => this.labelsMatch(e.labels, labels));

    if (existing) {
      existing.count++;
      existing.sum += value;
      this.incrementHistogramBuckets(existing, value);
    } else {
      const entry: HistogramValue = {
        count: 1,
        sum: value,
        buckets: DEFAULT_HISTOGRAM_BUCKETS.map((bucket) =>
          value <= bucket ? 1 : 0,
        ),
        labels,
      };
      entries.push(entry);
      this.histograms.set(metricName, entries);
    }
  }

  /**
   * Render all metrics in a simple text format.
   * Compatible with Prometheus text exposition format.
   */
  render(): string {
    const lines: string[] = [];

    // Counters
    for (const [name, entries] of this.counters) {
      const meta = this.metadata.get(name);
      if (meta?.help) lines.push(`# HELP ${name} ${meta.help}`);
      lines.push(`# TYPE ${name} counter`);
      for (const entry of entries) {
        lines.push(`${name}${this.renderLabels(entry.labels)} ${entry.value}`);
      }
    }

    // Gauges
    for (const [name, entries] of this.gauges) {
      const meta = this.metadata.get(name);
      if (meta?.help) lines.push(`# HELP ${name} ${meta.help}`);
      lines.push(`# TYPE ${name} gauge`);
      for (const entry of entries) {
        lines.push(`${name}${this.renderLabels(entry.labels)} ${entry.value}`);
      }
    }

    // Histograms
    for (const [name, entries] of this.histograms) {
      const meta = this.metadata.get(name);
      if (meta?.help) lines.push(`# HELP ${name} ${meta.help}`);
      lines.push(`# TYPE ${name} histogram`);
      for (const entry of entries) {
        for (let i = 0; i < DEFAULT_HISTOGRAM_BUCKETS.length; i++) {
          const bucket = DEFAULT_HISTOGRAM_BUCKETS[i];
          const le = Number.isFinite(bucket) ? String(bucket) : '+Inf';
          lines.push(
            `${name}_bucket${this.renderLabels({ ...entry.labels, le })} ${entry.buckets[i]}`,
          );
        }
        lines.push(
          `${name}_sum${this.renderLabels(entry.labels)} ${entry.sum}`,
        );
        lines.push(
          `${name}_count${this.renderLabels(entry.labels)} ${entry.count}`,
        );
      }
    }

    return lines.join('\n') + '\n';
  }

  /**
   * Reset all metrics (useful for testing).
   */
  reset() {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
  }

  private labelsMatch(
    a: Record<string, string>,
    b: Record<string, string>,
  ): boolean {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    return keysA.every((k) => a[k] === b[k]);
  }

  private incrementHistogramBuckets(
    entry: HistogramValue,
    value: number,
  ): void {
    for (let i = 0; i < DEFAULT_HISTOGRAM_BUCKETS.length; i++) {
      if (value <= DEFAULT_HISTOGRAM_BUCKETS[i]) {
        entry.buckets[i]++;
      }
    }
  }

  private renderLabels(labels: Record<string, string>): string {
    const entries = Object.entries(labels);
    if (entries.length === 0) return '';
    return `{${entries.map(([k, v]) => `${this.normalizeLabelName(k)}="${this.escapeLabelValue(v)}"`).join(',')}}`;
  }

  private normalizeMetricName(name: string): string {
    const normalized = name.replace(/[^a-zA-Z0-9_:]/g, '_');
    return /^[a-zA-Z_:]/.test(normalized) ? normalized : `_${normalized}`;
  }

  private normalizeLabelName(name: string): string {
    const normalized = name.replace(/[^a-zA-Z0-9_]/g, '_');
    return /^[a-zA-Z_]/.test(normalized) ? normalized : `_${normalized}`;
  }

  private escapeLabelValue(value: string): string {
    return value
      .replace(/\\/g, '\\\\')
      .replace(/\n/g, '\\n')
      .replace(/"/g, '\\"');
  }
}
