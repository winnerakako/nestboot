import { DBOS, DBOSClient, type WorkflowStatus } from '@dbos-inc/dbos-sdk';
import { Correlation } from '../logging/correlation.js';
import type { WorkflowRef } from './define.js';
import { type OpsEntry, type OpsKind, OpsMeta } from './ops-meta.js';

/**
 * The only way the app talks to the durable-execution engine.
 *
 * Two backings, one interface: a `worker` process drives the launched executor,
 * a `web` process drives a client that can enqueue and inspect but never
 * execute. Callers cannot tell which they have, which is what makes
 * "web never runs workflows" enforceable rather than aspirational — a web
 * process is structurally incapable of running one.
 */

/**
 * The statuses a workflow never leaves.
 *
 * MAX_RECOVERY_ATTEMPTS_EXCEEDED belongs here and is easy to forget — omitting
 * it meant those rows were never pruned and accumulated forever, and the
 * console treated them as still running.
 */
export const TERMINAL_STATUSES = [
  'SUCCESS',
  'ERROR',
  'CANCELLED',
  'MAX_RECOVERY_ATTEMPTS_EXCEEDED',
] as const;

export function isTerminal(status: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status.toUpperCase());
}

export interface StartOptions {
  /**
   * Idempotency key. Two starts with the same id are one workflow, so deriving
   * it from the thing being acted on (`invoice-paid:${invoiceId}`) makes a
   * double-submit or a retried request harmless.
   */
  workflowId?: string;
  queue?: string;
  /** Searchable in /ops. Correlation ids and ops metadata are added for you. */
  attributes?: Record<string, unknown>;
  timeoutMs?: number;
  /** 1 = highest. Leave unset for FIFO. */
  priority?: number;
  delaySeconds?: number;
}

export interface StartedWorkflow<Return> {
  readonly workflowId: string;
  /** Await completion. Almost never what a request handler wants. */
  result(): Promise<Return>;
  status(): Promise<WorkflowSummary | null>;
}

export interface WorkflowSummary {
  workflowId: string;
  name: string;
  status: string;
  queueName?: string;
  group?: string;
  feature?: string;
  kind?: OpsKind;
  description?: string;
  createdAt: Date;
  updatedAt?: Date;
  completedAt?: Date;
  input?: unknown[];
  output?: unknown;
  error?: unknown;
  recoveryAttempts?: number;
  requestId?: string;
  executorId?: string;
  queuePartitionKey?: string;
}

export interface WorkflowStepSummary {
  stepNumber: number;
  name: string;
  output?: unknown;
  error?: string | null;
  childWorkflowId?: string | null;
  startedAt?: Date;
  completedAt?: Date;
}

export interface WorkflowQuery {
  ids?: string[];
  name?: string | string[];
  status?: string | string[];
  queueName?: string | string[];
  /** Matched against workflow attributes, so `{ group: 'payments' }` filters in SQL. */
  attributes?: Record<string, unknown>;
  startTime?: Date;
  endTime?: Date;
  queuedOnly?: boolean;
  limit?: number;
  offset?: number;
  sortDesc?: boolean;
  loadInput?: boolean;
  loadOutput?: boolean;
}

export interface ScheduleSummary {
  name: string;
  workflowName: string;
  crontab: string;
  status: string;
  timezone: string | null;
  queueName: string | null;
  lastFiredAt: Date | null;
  backfillMissedRuns: boolean;
  group?: string;
  feature?: string;
  description?: string;
}

/**
 * The subset of the engine both a launched executor and a bare client expose.
 * Written against the two SDK surfaces, which are deliberately symmetrical.
 */
export interface DbosBackend {
  enqueue(options: EnqueueOptions, args: unknown[]): Promise<string>;
  listWorkflows(input: Record<string, unknown>): Promise<WorkflowStatus[]>;
  listQueuedWorkflows(input: Record<string, unknown>): Promise<WorkflowStatus[]>;
  getWorkflow(id: string): Promise<WorkflowStatus | null>;
  listSteps(id: string): Promise<WorkflowStepSummary[]>;
  getResult<T>(id: string): Promise<T>;
  cancel(id: string): Promise<void>;
  resume(id: string): Promise<void>;
  deleteWorkflows(ids: string[]): Promise<void>;
  fork(id: string, startStep: number): Promise<string>;
  send(destinationId: string, message: unknown, topic?: string): Promise<void>;
  getEvent<T>(id: string, key: string, timeoutSeconds: number): Promise<T | null>;
  listSchedules(): Promise<RawSchedule[]>;
  applySchedules(schedules: ApplySchedule[]): Promise<void>;
  updateSchedule(
    name: string,
    updates: { schedule?: string; queueName?: string | null },
  ): Promise<void>;
  pauseSchedule(name: string): Promise<void>;
  resumeSchedule(name: string): Promise<void>;
  deleteSchedule(name: string): Promise<void>;
  triggerSchedule(name: string): Promise<string>;
}

interface EnqueueOptions {
  queueName: string;
  workflowName: string;
  workflowClassName: string;
  workflowID?: string;
  attributes?: Record<string, unknown>;
  workflowTimeoutMS?: number;
  priority?: number;
  delaySeconds?: number;
}

interface RawSchedule {
  scheduleName: string;
  workflowName: string;
  schedule: string;
  status: string;
  cronTimezone: string | null;
  queueName: string | null;
  lastFiredAt: string | null;
  automaticBackfill: boolean;
}

/**
 * Carries the workflow both ways round because the two SDK surfaces disagree
 * here: the executor reconciles against a function reference it can call, the
 * client against a name it can only write down. A worker has both, so it
 * supplies both and each backend takes what it can use.
 */
interface ApplySchedule {
  scheduleName: string;
  workflowName: string;
  workflowFn: (scheduledAt: Date) => Promise<void>;
  workflowClassName?: string;
  schedule: string;
  cronTimezone?: string;
  queueName?: string;
  automaticBackfill?: boolean;
}

export class WorkflowRuntime {
  /**
   * The backing is resolved per call, not captured at construction: Nest builds
   * providers before `onApplicationBootstrap`, which is where the executor
   * launches, so an eagerly-bound backend would always be the one that does not
   * exist yet.
   */
  constructor(private readonly resolveBackend: () => DbosBackend) {}

  private get backend(): DbosBackend {
    return this.resolveBackend();
  }

  /**
   * Enqueue durable work.
   *
   * Everything is enqueued, including from a process that could have run it
   * inline. Inline execution ties the work's lifetime to the request that
   * started it, skips the queue's concurrency limit, and leaves nothing in /ops
   * to retry when it fails.
   */
  async start<Args extends unknown[], Return>(
    ref: WorkflowRef<Args, Return>,
    args: Args,
    options: StartOptions = {},
  ): Promise<StartedWorkflow<Return>> {
    const correlation = Correlation.get();

    const workflowId = await this.backend.enqueue(
      {
        queueName: options.queue ?? ref.queueName,
        workflowName: ref.name,
        workflowClassName: ref.className,
        workflowID: options.workflowId,
        workflowTimeoutMS: options.timeoutMs,
        priority: options.priority,
        delaySeconds: options.delaySeconds,
        attributes: {
          // Stamped so /ops can filter by them in SQL rather than joining an
          // in-memory map it can only build for workflows this build declares.
          group: ref.group,
          feature: ref.feature,
          kind: ref.kind,
          ...(correlation.requestId ? { requestId: correlation.requestId } : {}),
          ...(correlation.traceId ? { traceId: correlation.traceId } : {}),
          ...options.attributes,
        },
      },
      args,
    );

    return {
      workflowId,
      result: () => this.backend.getResult<Return>(workflowId),
      status: () => this.get(workflowId),
    };
  }

  async list(query: WorkflowQuery = {}): Promise<WorkflowSummary[]> {
    const input = toGetWorkflowsInput(query);
    const rows = query.queuedOnly
      ? await this.backend.listQueuedWorkflows(input)
      : await this.backend.listWorkflows(input);
    return rows.map(toSummary);
  }

  async get(id: string): Promise<WorkflowSummary | null> {
    const status = await this.backend.getWorkflow(id);
    return status ? toSummary(status) : null;
  }

  steps(id: string): Promise<WorkflowStepSummary[]> {
    return this.backend.listSteps(id);
  }

  cancel(id: string): Promise<void> {
    return this.backend.cancel(id);
  }

  /** Re-run from the first step that never completed. */
  resume(id: string): Promise<void> {
    return this.backend.resume(id);
  }

  /**
   * Re-run from a chosen step as a new workflow, keeping the checkpoints before
   * it. The repair tool for "step 7 wrote the wrong thing because of a bug we
   * have now fixed": redeploy, fork from 7, and steps 1-6 do not happen twice.
   */
  fork(id: string, startStep: number): Promise<string> {
    return this.backend.fork(id, startStep);
  }

  /** Deliver a decision a workflow is parked on `waitForSignal` waiting for. */
  signal(workflowId: string, topic: string, payload: unknown): Promise<void> {
    return this.backend.send(workflowId, payload, topic);
  }

  readStatus<T>(workflowId: string, key: string, timeoutSeconds = 0): Promise<T | null> {
    return this.backend.getEvent<T>(workflowId, key, timeoutSeconds);
  }

  async schedules(): Promise<ScheduleSummary[]> {
    const rows = await this.backend.listSchedules();
    return rows.map((row) => {
      const meta = OpsMeta.get(row.workflowName);
      return {
        name: row.scheduleName,
        workflowName: row.workflowName,
        crontab: row.schedule,
        status: row.status,
        timezone: row.cronTimezone,
        queueName: row.queueName,
        lastFiredAt: row.lastFiredAt ? new Date(row.lastFiredAt) : null,
        backfillMissedRuns: row.automaticBackfill,
        // Group and description come from the workflow's own @OpsMeta rather
        // than a column on the schedule: a schedule that runs the nightly
        // reconciliation belongs to whatever group that workflow belongs to,
        // and storing it twice is how the two disagree.
        group: meta?.group,
        feature: meta?.feature,
        description: meta?.description,
      };
    });
  }

  applySchedules(schedules: ApplySchedule[]): Promise<void> {
    return this.backend.applySchedules(schedules);
  }

  updateSchedule(
    name: string,
    updates: { crontab?: string; queueName?: string | null },
  ): Promise<void> {
    return this.backend.updateSchedule(name, {
      schedule: updates.crontab,
      queueName: updates.queueName,
    });
  }

  pauseSchedule(name: string): Promise<void> {
    return this.backend.pauseSchedule(name);
  }

  resumeSchedule(name: string): Promise<void> {
    return this.backend.resumeSchedule(name);
  }

  deleteSchedule(name: string): Promise<void> {
    return this.backend.deleteSchedule(name);
  }

  /** Run a schedule now, out of band. The run appears in /ops like any other. */
  runScheduleNow(name: string): Promise<string> {
    return this.backend.triggerSchedule(name);
  }

  /**
   * Delete finished workflow history older than `olderThan`, in one batch.
   * Returns how many rows went.
   *
   * Lives here rather than in housekeeping because it is vendor knowledge:
   * which statuses are terminal, and how a workflow's steps, messages and
   * events are removed with it. Housekeeping issuing `DELETE FROM
   * dbos.workflow_status` directly would couple a schedule to the SDK's private
   * schema, and would silently stop working — or start orphaning rows — the
   * first time that schema changed.
   */
  async pruneHistory(olderThan: Date, limit = 5_000): Promise<number> {
    const finished = await this.list({
      status: [...TERMINAL_STATUSES],
      endTime: olderThan,
      limit,
    });
    if (finished.length === 0) return 0;

    // `deleteChildren` is the SDK's own cascade: a parent's steps, messages and
    // events go with it, so nothing is orphaned.
    await this.backend.deleteWorkflows(finished.map((workflow) => workflow.workflowId));
    return finished.length;
  }

  /** Everything this build declares, for the group/feature filters in /ops. */
  registry(): OpsEntry[] {
    return OpsMeta.all();
  }
}

function toGetWorkflowsInput(query: WorkflowQuery): Record<string, unknown> {
  return {
    workflowIDs: query.ids,
    workflowName: query.name,
    status: query.status,
    queueName: query.queueName,
    attributes: query.attributes,
    startTime: query.startTime?.toISOString(),
    endTime: query.endTime?.toISOString(),
    limit: query.limit,
    offset: query.offset,
    sortDesc: query.sortDesc ?? true,
    loadInput: query.loadInput ?? false,
    loadOutput: query.loadOutput ?? false,
  };
}

function toSummary(status: WorkflowStatus): WorkflowSummary {
  const attributes = status.attributes ?? {};
  const meta = OpsMeta.get(status.workflowName);

  return {
    workflowId: status.workflowID,
    name: status.workflowName,
    status: status.status,
    queueName: status.queueName,
    // Prefer the attribute recorded when the workflow started: a running build
    // that no longer declares this workflow still shows the group it ran under.
    group: asString(attributes.group) ?? meta?.group,
    feature: asString(attributes.feature) ?? meta?.feature,
    kind: (asString(attributes.kind) as OpsKind | undefined) ?? meta?.kind,
    description: meta?.description,
    requestId: asString(attributes.requestId),
    createdAt: new Date(status.createdAt),
    updatedAt: status.updatedAt ? new Date(status.updatedAt) : undefined,
    completedAt: status.completedAt ? new Date(status.completedAt) : undefined,
    input: status.input,
    output: status.output,
    error: status.error,
    recoveryAttempts: status.recoveryAttempts,
    executorId: status.executorId,
    queuePartitionKey: status.queuePartitionKey,
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function toStepSummaries(
  steps: Array<{
    functionID: number;
    name: string;
    output: unknown;
    error: Error | null;
    childWorkflowID: string | null;
    startedAtEpochMs?: number;
    completedAtEpochMs?: number;
  }>,
): WorkflowStepSummary[] {
  return steps.map((s) => ({
    stepNumber: s.functionID,
    name: s.name,
    output: s.output,
    error: s.error ? (s.error.message ?? String(s.error)) : null,
    childWorkflowId: s.childWorkflowID,
    startedAt: s.startedAtEpochMs ? new Date(s.startedAtEpochMs) : undefined,
    completedAt: s.completedAtEpochMs ? new Date(s.completedAtEpochMs) : undefined,
  }));
}

/** Backed by the launched executor: `ROLE=worker` and `ROLE=all`. */
export class ExecutorBackend implements DbosBackend {
  async enqueue(options: EnqueueOptions, args: unknown[]): Promise<string> {
    const handle = await DBOS.enqueueWorkflowWithOptions(options, ...args);
    return handle.workflowID;
  }
  listWorkflows(input: Record<string, unknown>) {
    return DBOS.listWorkflows(input);
  }
  listQueuedWorkflows(input: Record<string, unknown>) {
    return DBOS.listQueuedWorkflows(input);
  }
  getWorkflow(id: string) {
    return DBOS.getWorkflowStatus(id);
  }
  async listSteps(id: string) {
    return toStepSummaries((await DBOS.listWorkflowSteps(id)) ?? []);
  }
  getResult<T>(id: string): Promise<T> {
    return DBOS.retrieveWorkflow<T>(id).getResult();
  }
  cancel(id: string) {
    return DBOS.cancelWorkflow(id);
  }
  async resume(id: string) {
    await DBOS.resumeWorkflow(id);
  }
  deleteWorkflows(ids: string[]) {
    return DBOS.deleteWorkflows(ids, true);
  }
  async fork(id: string, startStep: number) {
    const handle = await DBOS.forkWorkflow(id, startStep);
    return handle.workflowID;
  }
  send(destinationId: string, message: unknown, topic?: string) {
    return DBOS.send(destinationId, message, topic);
  }
  getEvent<T>(id: string, key: string, timeoutSeconds: number) {
    return DBOS.getEvent<T>(id, key, timeoutSeconds);
  }
  listSchedules() {
    return DBOS.listSchedules() as unknown as Promise<RawSchedule[]>;
  }
  applySchedules(schedules: ApplySchedule[]) {
    return DBOS.applySchedules(
      schedules.map(
        ({ scheduleName, workflowFn, schedule, cronTimezone, queueName, automaticBackfill }) => ({
          scheduleName,
          workflowFn,
          schedule,
          cronTimezone,
          queueName,
          automaticBackfill,
        }),
      ),
    );
  }
  updateSchedule(name: string, updates: { schedule?: string; queueName?: string | null }) {
    return DBOS.updateSchedule(name, updates);
  }
  pauseSchedule(name: string) {
    return DBOS.pauseSchedule(name);
  }
  resumeSchedule(name: string) {
    return DBOS.resumeSchedule(name);
  }
  deleteSchedule(name: string) {
    return DBOS.deleteSchedule(name);
  }
  async triggerSchedule(name: string) {
    const handle = await DBOS.triggerSchedule(name);
    return handle.workflowID;
  }
}

/**
 * Backed by a bare client: `ROLE=web`.
 *
 * It can enqueue, inspect, cancel, resume and fork — everything /ops needs —
 * and cannot execute a single step, because there is no executor to execute it.
 */
export class ClientBackend implements DbosBackend {
  constructor(private readonly client: DBOSClient) {}

  static async create(systemDatabaseUrl: string, applicationName: string): Promise<ClientBackend> {
    return new ClientBackend(await DBOSClient.create({ systemDatabaseUrl, applicationName }));
  }

  async destroy(): Promise<void> {
    await this.client.destroy();
  }

  async enqueue(options: EnqueueOptions, args: unknown[]): Promise<string> {
    const handle = await this.client.enqueue(options, ...args);
    return handle.workflowID;
  }
  listWorkflows(input: Record<string, unknown>) {
    return this.client.listWorkflows(input);
  }
  listQueuedWorkflows(input: Record<string, unknown>) {
    return this.client.listQueuedWorkflows(input);
  }
  async getWorkflow(id: string) {
    return (await this.client.getWorkflow(id)) ?? null;
  }
  async listSteps(id: string) {
    return toStepSummaries((await this.client.listWorkflowSteps(id)) ?? []);
  }
  getResult<T>(id: string): Promise<T> {
    return this.client.retrieveWorkflow<T>(id).getResult();
  }
  cancel(id: string) {
    return this.client.cancelWorkflow(id);
  }
  async resume(id: string) {
    await this.client.resumeWorkflow(id);
  }
  deleteWorkflows(ids: string[]) {
    return this.client.deleteWorkflows(ids, true);
  }
  // Intentional: the client returns the new workflow id directly where the
  // executor returns a handle — an asymmetry in the SDK, normalised here.
  fork(id: string, startStep: number) {
    return this.client.forkWorkflow(id, startStep);
  }
  send(destinationId: string, message: unknown, topic?: string) {
    return this.client.send(destinationId, message, topic);
  }
  getEvent<T>(id: string, key: string, timeoutSeconds: number) {
    return this.client.getEvent<T>(id, key, timeoutSeconds);
  }
  listSchedules() {
    return this.client.listSchedules() as unknown as Promise<RawSchedule[]>;
  }
  applySchedules(schedules: ApplySchedule[]) {
    return this.client.applySchedules(schedules.map(({ workflowFn: _fn, ...rest }) => rest));
  }
  updateSchedule(name: string, updates: { schedule?: string; queueName?: string | null }) {
    return this.client.updateSchedule(name, updates);
  }
  pauseSchedule(name: string) {
    return this.client.pauseSchedule(name);
  }
  resumeSchedule(name: string) {
    return this.client.resumeSchedule(name);
  }
  deleteSchedule(name: string) {
    return this.client.deleteSchedule(name);
  }
  async triggerSchedule(name: string) {
    const handle = await this.client.triggerSchedule(name);
    return handle.workflowID;
  }
}
