import { DBOS, type WorkflowQueue } from '@dbos-inc/dbos-sdk';
import { inferFeature, type OpsKind, OpsMeta, type OpsMetaInput } from './ops-meta.js';
import { Queues } from './queues.js';

/**
 * How a feature declares background work.
 *
 * These are functions rather than the decorated static classes DBOS documents,
 * for one reason: a `ROLE=web` process has no DBOS executor, so it must enqueue
 * a workflow *by name*. A definition that returns a handle carrying both the
 * callable and its registered identity lets one `runtime.start(ref, args)` work
 * identically whether the caller can execute workflows or only enqueue them.
 * With decorators the caller would have to repeat the class and method name as
 * strings at every call site, and those strings are unchecked.
 */

export interface WorkflowRef<Args extends unknown[], Return> {
  readonly name: string;
  readonly className: string;
  readonly kind: OpsKind;
  /** Where `runtime.start()` enqueues this by default. */
  readonly queueName: string;
  readonly group: string;
  readonly description: string;
  readonly feature: string;
  /**
   * Call it durably *in this process*. Legitimate only from inside another
   * workflow (as a child) — from anywhere else use `runtime.start()`, so the
   * work is queued, visible in /ops, and survives this process dying.
   */
  readonly invoke: (...args: Args) => Promise<Return>;
}

interface BaseDefinition {
  /** Unique across the app; this is what DBOS recovers by and /ops filters on. */
  name: string;
  meta: OpsMetaInput;
  queue?: WorkflowQueue;
}

export interface WorkflowDefinition<Args extends unknown[], Return> extends BaseDefinition {
  run: (...args: Args) => Promise<Return>;
}

function register<Args extends unknown[], Return>(
  definition: WorkflowDefinition<Args, Return>,
  kind: OpsKind,
  className: string,
  extra: { crontab?: string } = {},
): WorkflowRef<Args, Return> {
  const queueName = (definition.queue ?? Queues.default).name;
  const feature = definition.meta.feature ?? inferFeature(4);

  OpsMeta.register({
    name: definition.name,
    className,
    kind,
    group: definition.meta.group,
    description: definition.meta.description,
    feature,
    queueName,
    ...extra,
  });

  const invoke = DBOS.registerWorkflow(definition.run, {
    name: definition.name,
    className,
  }) as (...args: Args) => Promise<Return>;

  return Object.freeze({
    name: definition.name,
    className,
    kind,
    queueName,
    group: definition.meta.group,
    description: definition.meta.description,
    feature,
    invoke,
  });
}

/**
 * A multi-step, durable process. Reach for this whenever failing halfway
 * through would leave the world inconsistent — money moved but nothing
 * recorded, an account created but never provisioned.
 */
export function defineWorkflow<Args extends unknown[], Return>(
  definition: WorkflowDefinition<Args, Return>,
): WorkflowRef<Args, Return> {
  return register(definition, 'workflow', 'Workflow');
}

/**
 * One external effect with retries: send this email, deliver this webhook.
 *
 * A job is a one-step workflow, so it shows up in the same list, retries the
 * same way, and is resumable — the difference from a workflow is intent, not
 * machinery. If you find yourself adding a second step, it was a workflow.
 */
export function defineJob<Args extends unknown[], Return>(
  definition: WorkflowDefinition<Args, Return>,
): WorkflowRef<Args, Return> {
  return register(definition, 'job', 'Job');
}

/** A reaction to a domain event. Registered by `@OnEvent`; one per listener. */
export function defineListener<Args extends unknown[], Return>(
  definition: WorkflowDefinition<Args, Return>,
): WorkflowRef<Args, Return> {
  return register({ queue: Queues.events, ...definition }, 'listener', 'Listener');
}

/** The processing half of an inbound webhook, after the signature is verified. */
export function defineWebhookHandler<Args extends unknown[], Return>(
  definition: WorkflowDefinition<Args, Return>,
): WorkflowRef<Args, Return> {
  return register({ queue: Queues.webhooksIn, ...definition }, 'webhook', 'Webhook');
}

export interface ScheduleDefinition extends BaseDefinition {
  /** 5- or 6-field crontab, evaluated in `timezone`. */
  crontab: string;
  /** IANA zone. UTC unless the schedule is tied to a human business day. */
  timezone?: string;
  /**
   * Run the slots that were missed while the app was down. Correct for a daily
   * report, wrong for "charge every overdue invoice" — that one would fire a
   * month of charges at once after a long outage.
   */
  backfillMissedRuns?: boolean;
  run: (scheduledAt: Date) => Promise<void>;
}

export interface ScheduleRef extends WorkflowRef<[Date], void> {
  readonly crontab: string;
  readonly timezone: string;
  readonly backfillMissedRuns: boolean;
}

/**
 * A recurring workflow.
 *
 * Declared in code, reconciled into DBOS's own schedule table at worker boot
 * (see `DbosService`), so code-declared and operator-created schedules are one
 * list in /ops with one set of controls — rather than a static set nobody can
 * pause and a dynamic set nobody can review.
 */
export function defineSchedule(definition: ScheduleDefinition): ScheduleRef {
  const ref = register(
    {
      name: definition.name,
      meta: definition.meta,
      queue: definition.queue,
      run: definition.run,
    },
    'schedule',
    'Schedule',
    { crontab: definition.crontab },
  );

  const scheduleRef: ScheduleRef = Object.freeze({
    ...ref,
    crontab: definition.crontab,
    timezone: definition.timezone ?? 'UTC',
    backfillMissedRuns: definition.backfillMissedRuns ?? false,
  });

  scheduled.push(scheduleRef);
  return scheduleRef;
}

const scheduled: ScheduleRef[] = [];

/** Every schedule declared in code, for the boot-time reconcile. */
export function declaredSchedules(): readonly ScheduleRef[] {
  return scheduled;
}

export interface StepOptions {
  /** Retry on failure. Only safe when the step is idempotent, or does not matter twice. */
  retries?: number;
  /** Seconds before the first retry; doubles by `backoffRate` after that. */
  intervalSeconds?: number;
  backoffRate?: number;
  /** Fail a single attempt after this long. */
  timeoutMs?: number;
  /** Retry only some errors — a 429 yes, a 400 never. */
  shouldRetry?: (error: unknown) => boolean | Promise<boolean>;
}

/**
 * A checkpoint inside a workflow. Once it succeeds it never runs again, even if
 * the workflow is resumed from a later crash — which is what makes "charge the
 * card" safe to have in the middle of a long process.
 *
 * Everything with an outside effect belongs in one: HTTP calls, sending mail,
 * writing to another system, reading the clock, generating a random id. Pure
 * computation does not — checkpointing it just writes rows.
 */
export function step<T>(name: string, fn: () => Promise<T>): Promise<T>;
export function step<T>(name: string, options: StepOptions, fn: () => Promise<T>): Promise<T>;
export function step<T>(
  name: string,
  optionsOrFn: StepOptions | (() => Promise<T>),
  maybeFn?: () => Promise<T>,
): Promise<T> {
  const fn = typeof optionsOrFn === 'function' ? optionsOrFn : maybeFn!;
  const options = typeof optionsOrFn === 'function' ? {} : optionsOrFn;

  return DBOS.runStep(fn, {
    name,
    retriesAllowed: options.retries !== undefined && options.retries > 0,
    maxAttempts: options.retries,
    intervalSeconds: options.intervalSeconds,
    backoffRate: options.backoffRate,
    timeoutMS: options.timeoutMs,
    shouldRetry: options.shouldRetry,
  });
}

/** Pause a workflow durably. Survives deploys; costs nothing while it waits. */
export function sleep(ms: number): Promise<void> {
  return DBOS.sleepms(ms);
}

/** Wait for an outside decision (a human approving, a provider calling back). */
export function waitForSignal<T>(topic: string, timeoutSeconds: number): Promise<T | null> {
  return DBOS.recv<T>(topic, timeoutSeconds);
}

/** Publish progress that `/ops` and the API can read while the workflow runs. */
export function publishStatus<T>(key: string, value: T): Promise<void> {
  return DBOS.setEvent(key, value);
}

/** The id of the workflow currently running, or undefined outside one. */
export function currentWorkflowId(): string | undefined {
  return DBOS.isInWorkflow() ? DBOS.workflowID : undefined;
}
