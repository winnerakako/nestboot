import { sep } from 'node:path';

/**
 * Every background thing carries the label an operator would actually use.
 *
 * At 3am nobody asks "is `LoanOriginationWorkflow` failing", they ask "is
 * payments broken". DBOS knows a workflow's class and method name and nothing
 * else, so the group has to come from us — and it has to be mandatory, because
 * a grouping dimension that is 80% populated is worse than none: the tab lies
 * by omission.
 */

export type OpsKind = 'workflow' | 'job' | 'schedule' | 'listener' | 'webhook';

export interface OpsMetaInput {
  /**
   * Free-form operator label: `payments`, `notifications`, `housekeeping`.
   * Reuse an existing one — `OpsMeta.groups()` is what the generators suggest.
   */
  group: string;
  description: string;
  /** Inferred from the file path; pass it only to override. */
  feature?: string;
}

export interface OpsEntry extends Required<OpsMetaInput> {
  name: string;
  className: string;
  kind: OpsKind;
  queueName?: string;
  crontab?: string;
}

class OpsMetaRegistry {
  private readonly entries = new Map<string, OpsEntry>();

  register(entry: OpsEntry): OpsEntry {
    const existing = this.entries.get(entry.name);
    if (existing && existing.className !== entry.className) {
      throw new Error(
        `Two background functions are both named "${entry.name}" ` +
          `(${existing.className} and ${entry.className}).\n` +
          'FIX: the name is the identity DBOS recovers a workflow by and /ops filters on, ' +
          'so it must be unique across the app. Rename one.',
      );
    }
    this.entries.set(entry.name, entry);
    return entry;
  }

  get(name: string): OpsEntry | undefined {
    return this.entries.get(name);
  }

  all(): OpsEntry[] {
    return [...this.entries.values()].sort(
      (a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name),
    );
  }

  groups(): string[] {
    return [...new Set(this.all().map((e) => e.group))].sort();
  }

  byGroup(): Map<string, OpsEntry[]> {
    const out = new Map<string, OpsEntry[]>();
    for (const entry of this.all()) {
      const list = out.get(entry.group);
      if (list) list.push(entry);
      else out.set(entry.group, [entry]);
    }
    return out;
  }

  /** Test-only: the registry is populated at import time and frozen in practice. */
  reset(): void {
    this.entries.clear();
  }
}

export const OpsMeta = new OpsMetaRegistry();

/**
 * Work out which feature a workflow belongs to from where it was defined.
 *
 * Intentional: this reads a synthetic stack trace. The alternative is making
 * every `defineWorkflow` call repeat a feature name that its own path already
 * states, which drifts the first time a file is moved. It runs once per
 * definition at import time, and falls back to 'platform' if the stack is
 * unreadable, so nothing breaks if a bundler rewrites paths.
 */
export function inferFeature(depth = 3): string {
  const stack = new Error().stack?.split('\n') ?? [];
  for (const line of stack.slice(depth)) {
    const match = /[/\\]features[/\\]([^/\\]+)[/\\]/.exec(line.split(sep).join(sep));
    if (match?.[1]) return match[1];
  }
  return 'platform';
}
