import { Injectable, Logger } from '@nestjs/common';

/**
 * Lightweight in-process metrics collection.
 * No external dependencies — collects counters, gauges, and histograms
 * and exposes them via the /metrics endpoint in a simple text format.
 *
 * Usage:
 *   this.metrics.increment('http.requests', { method: 'GET', path: '/api/users' });
 *   this.metrics.gauge('websocket.connections', count);
 *   this.metrics.histogram('http.duration_ms', durationMs, { path: '/api/users' });
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
  min: number;
  max: number;
  labels: Record<string, string>;
}

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
    this.metadata.set(name, { name, type, help });
  }

  /**
   * Increment a counter. Creates the counter if it doesn't exist.
   */
  increment(name: string, labels: Record<string, string> = {}, value = 1) {
    if (!this.metadata.has(name)) {
      this.metadata.set(name, { name, type: 'counter' });
    }

    const entries = this.counters.get(name) || [];
    const existing = entries.find((e) => this.labelsMatch(e.labels, labels));

    if (existing) {
      existing.value += value;
    } else {
      entries.push({ value, labels });
      this.counters.set(name, entries);
    }
  }

  /**
   * Set a gauge to a specific value. Creates the gauge if it doesn't exist.
   */
  gauge(name: string, value: number, labels: Record<string, string> = {}) {
    if (!this.metadata.has(name)) {
      this.metadata.set(name, { name, type: 'gauge' });
    }

    const entries = this.gauges.get(name) || [];
    const existing = entries.find((e) => this.labelsMatch(e.labels, labels));

    if (existing) {
      existing.value = value;
    } else {
      entries.push({ value, labels });
      this.gauges.set(name, entries);
    }
  }

  /**
   * Record a histogram observation (e.g., latency, size).
   */
  histogram(name: string, value: number, labels: Record<string, string> = {}) {
    if (!this.metadata.has(name)) {
      this.metadata.set(name, { name, type: 'histogram' });
    }

    const entries = this.histograms.get(name) || [];
    const existing = entries.find((e) => this.labelsMatch(e.labels, labels));

    if (existing) {
      existing.count++;
      existing.sum += value;
      existing.min = Math.min(existing.min, value);
      existing.max = Math.max(existing.max, value);
    } else {
      entries.push({ count: 1, sum: value, min: value, max: value, labels });
      this.histograms.set(name, entries);
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

    // Histograms (rendered as count, sum, min, max)
    for (const [name, entries] of this.histograms) {
      const meta = this.metadata.get(name);
      if (meta?.help) lines.push(`# HELP ${name} ${meta.help}`);
      lines.push(`# TYPE ${name} histogram`);
      for (const entry of entries) {
        const lbl = this.renderLabels(entry.labels);
        lines.push(`${name}_count${lbl} ${entry.count}`);
        lines.push(`${name}_sum${lbl} ${entry.sum}`);
        lines.push(`${name}_min${lbl} ${entry.min}`);
        lines.push(`${name}_max${lbl} ${entry.max}`);
        lines.push(
          `${name}_avg${lbl} ${entry.count > 0 ? Math.round(entry.sum / entry.count) : 0}`,
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

  private renderLabels(labels: Record<string, string>): string {
    const entries = Object.entries(labels);
    if (entries.length === 0) return '';
    return `{${entries.map(([k, v]) => `${k}="${v}"`).join(',')}}`;
  }
}
