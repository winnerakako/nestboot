import Handlebars from 'handlebars';
import { levelName } from '../ops-query.js';

/**
 * The formatting every tab shares.
 *
 * These live here rather than in each controller because a duration rendered
 * three different ways across three tabs is how a console stops being readable
 * at a glance — which is the only thing it is for.
 */
export function registerHelpers(handlebars: typeof Handlebars): void {
  /** "4m ago", with the absolute time on hover. Relative is what people scan. */
  handlebars.registerHelper('ago', (value: unknown) => {
    const date = toDate(value);
    if (!date) return new Handlebars.SafeString('<span class="muted">—</span>');
    return new Handlebars.SafeString(
      `<time datetime="${escapeHtml(date.toISOString())}" title="${escapeHtml(date.toISOString())}">${escapeHtml(
        relativeTime(date),
      )}</time>`,
    );
  });

  handlebars.registerHelper('datetime', (value: unknown) => {
    const date = toDate(value);
    return date ? date.toISOString().replace('T', ' ').replace('Z', '') : '—';
  });

  /** Durations read differently at different scales; one rule for all of them. */
  handlebars.registerHelper('duration', (ms: unknown) => {
    const value = Number(ms);
    if (!Number.isFinite(value)) return '—';
    if (value < 1) return '<1ms';
    if (value < 1000) return `${Math.round(value)}ms`;
    if (value < 60_000) return `${(value / 1000).toFixed(1)}s`;
    if (value < 3_600_000)
      return `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1000)}s`;
    return `${Math.floor(value / 3_600_000)}h ${Math.round((value % 3_600_000) / 60_000)}m`;
  });

  /** Milliseconds between two timestamps, for `{{duration (subtractDates a b)}}`. */
  handlebars.registerHelper('subtractDates', (later: unknown, earlier: unknown) => {
    const a = toDate(later);
    const b = toDate(earlier);
    return a && b ? a.getTime() - b.getTime() : Number.NaN;
  });

  handlebars.registerHelper('number', (value: unknown) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(Math.round(n));
  });

  handlebars.registerHelper('percent', (value: unknown) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    if (n === 0) return '0%';
    if (n < 0.001) return '<0.1%';
    return `${(n * 100).toFixed(1)}%`;
  });

  handlebars.registerHelper('levelName', (value: unknown) => levelName(Number(value)));

  /** The colour vocabulary is shared, so "red" means the same on every tab. */
  handlebars.registerHelper('levelClass', (value: unknown) => {
    const n = Number(value);
    if (n >= 60) return 'lvl-fatal';
    if (n >= 50) return 'lvl-error';
    if (n >= 40) return 'lvl-warn';
    if (n >= 30) return 'lvl-info';
    return 'lvl-debug';
  });

  handlebars.registerHelper('statusClass', (value: unknown) => {
    const n = Number(value);
    if (n >= 500) return 'bad';
    if (n >= 400) return 'warn';
    if (n >= 300) return 'muted';
    return 'good';
  });

  handlebars.registerHelper('workflowStatusClass', (value: unknown) => {
    switch (String(value).toUpperCase()) {
      case 'SUCCESS':
        return 'good';
      case 'ERROR':
      case 'MAX_RECOVERY_ATTEMPTS_EXCEEDED':
        return 'bad';
      case 'CANCELLED':
        return 'muted';
      case 'PENDING':
      case 'ENQUEUED':
        return 'warn';
      default:
        return 'muted';
    }
  });

  /** Pretty-printed, key-sorted JSON so two payloads can be eyeballed against each other. */
  handlebars.registerHelper('json', (value: unknown) => {
    if (value === undefined || value === null) return '';
    try {
      return JSON.stringify(value, Object.keys(flatten(value)).sort(), 2);
    } catch {
      return String(value);
    }
  });

  handlebars.registerHelper('jsonCompact', (value: unknown) => {
    if (value === undefined || value === null) return '';
    try {
      const text = JSON.stringify(value);
      return text.length > 200 ? `${text.slice(0, 200)}…` : text;
    } catch {
      return String(value);
    }
  });

  /** Short form of an id: enough to recognise, short enough for a dense table. */
  handlebars.registerHelper('shortId', (value: unknown) => {
    const text = String(value ?? '');
    return text.length > 20 ? `${text.slice(0, 8)}…${text.slice(-6)}` : text;
  });

  handlebars.registerHelper('truncate', (value: unknown, length: unknown) => {
    const text = String(value ?? '');
    const max = Number(length) || 80;
    return text.length > max ? `${text.slice(0, max)}…` : text;
  });

  handlebars.registerHelper('multiply', (a: unknown, b: unknown) => Number(a) * Number(b));
  handlebars.registerHelper('eq', (a: unknown, b: unknown) => a === b);
  handlebars.registerHelper('gt', (a: unknown, b: unknown) => Number(a) > Number(b));
  handlebars.registerHelper('or', (...args: unknown[]) => args.slice(0, -1).some(Boolean));
  handlebars.registerHelper('not', (value: unknown) => !value);
  handlebars.registerHelper(
    'coalesce',
    (...args: unknown[]) =>
      args.slice(0, -1).find((v) => v !== undefined && v !== null && v !== '') ?? '',
  );

  /** A one-line inline sparkline, so a regression is visible without clicking. */
  handlebars.registerHelper('sparkline', (values: unknown) => {
    if (!Array.isArray(values) || values.length === 0) return '';
    const numbers = values.map(Number).filter(Number.isFinite);
    if (numbers.length === 0) return '';
    const max = Math.max(...numbers, 1);
    const blocks = '▁▂▃▄▅▆▇█';
    const rendered = numbers
      .map((n) => blocks[Math.min(blocks.length - 1, Math.floor((n / max) * (blocks.length - 1)))])
      .join('');
    return new Handlebars.SafeString(
      `<span class="spark" title="max ${max}">${escapeHtml(rendered)}</span>`,
    );
  });
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

export function relativeTime(date: Date, now = new Date()): string {
  const seconds = Math.round((now.getTime() - date.getTime()) / 1000);
  const future = seconds < 0;
  const abs = Math.abs(seconds);

  const text =
    abs < 5
      ? 'just now'
      : abs < 60
        ? `${abs}s`
        : abs < 3600
          ? `${Math.floor(abs / 60)}m`
          : abs < 86_400
            ? `${Math.floor(abs / 3600)}h`
            : abs < 2_592_000
              ? `${Math.floor(abs / 86_400)}d`
              : date.toISOString().slice(0, 10);

  if (text === 'just now' || text.length === 10) return text;
  return future ? `in ${text}` : `${text} ago`;
}

function flatten(value: unknown): Record<string, true> {
  const keys: Record<string, true> = {};
  const visit = (node: unknown): void => {
    if (node && typeof node === 'object' && !Array.isArray(node)) {
      for (const [key, child] of Object.entries(node)) {
        keys[key] = true;
        visit(child);
      }
    } else if (Array.isArray(node)) {
      for (const child of node) visit(child);
    }
  };
  visit(value);
  return keys;
}

function escapeHtml(value: string): string {
  return Handlebars.escapeExpression(value);
}
