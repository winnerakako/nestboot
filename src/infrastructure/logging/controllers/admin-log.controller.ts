import {
  Controller,
  Get,
  Patch,
  Param,
  Query,
  Body,
  BadRequestException,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiOperation, ApiTags, ApiQuery } from '@nestjs/swagger';
import { LogConnectionService } from '../services/log-connection.service';
import { CronService } from '../../cron/cron.service';

const ALLOWED_STATS_SORT = [
  'avgDuration',
  'requestCount',
  'errorCount',
  'p95Duration',
];
const MAX_LIMIT = 200;
const DISABLED_RESPONSE = {
  data: null,
  message: 'Logging disabled — MONGO_LOG_URI not configured',
};

function safePagination(page: string, limit: string) {
  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.min(MAX_LIMIT, Math.max(1, parseInt(limit, 10) || 50));
  return { page: p, limit: l, skip: (p - 1) * l };
}

function sanitizeString(value: string): string {
  return value.replace(/[${}]/g, '');
}

function parseOptionalInteger(
  value: string | undefined,
  field: string,
  min?: number,
): number | undefined {
  if (value === undefined || value === '') return undefined;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || (min !== undefined && parsed < min)) {
    throw new BadRequestException(`${field} must be an integer`);
  }

  return parsed;
}

function parseOptionalDate(
  value: string | undefined,
  field: string,
): Date | undefined {
  if (value === undefined || value === '') return undefined;

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException(`${field} must be a valid date`);
  }

  return parsed;
}

function ensureObjectBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequestException('Request body must be an object');
  }

  return body as Record<string, unknown>;
}

function parseRequiredBoolean(body: unknown, field: string): boolean {
  const record = ensureObjectBody(body);
  const value = record[field];

  if (typeof value !== 'boolean') {
    throw new BadRequestException(`${field} must be a boolean`);
  }

  return value;
}

function parseOptionalBoolean(
  body: Record<string, unknown>,
  field: string,
): boolean | undefined {
  if (!Object.prototype.hasOwnProperty.call(body, field)) return undefined;

  const value = body[field];
  if (typeof value !== 'boolean') {
    throw new BadRequestException(`${field} must be a boolean`);
  }

  return value;
}

function parseOptionalString(
  body: Record<string, unknown>,
  field: string,
): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(body, field)) return undefined;

  const value = body[field];
  if (typeof value !== 'string') {
    throw new BadRequestException(`${field} must be a string`);
  }

  return value;
}

@ApiTags('Admin / Logs')
@Controller('admin/logs')
export class AdminLogController {
  constructor(
    private readonly conn: LogConnectionService,
    private readonly cronService: CronService,
  ) {}

  // ─── Request Logs ────────────────────────────────────────

  @Get('requests')
  @ApiOperation({ summary: 'Get request logs (paginated, filterable)' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'routeKey', required: false })
  @ApiQuery({ name: 'statusCode', required: false })
  @ApiQuery({ name: 'minDuration', required: false })
  @ApiQuery({ name: 'userId', required: false })
  @ApiQuery({ name: 'from', required: false, description: 'ISO date' })
  @ApiQuery({ name: 'to', required: false, description: 'ISO date' })
  async getRequestLogs(
    @Query('page') page = '1',
    @Query('limit') limit = '50',
    @Query('routeKey') routeKey?: string,
    @Query('statusCode') statusCode?: string,
    @Query('minDuration') minDuration?: string,
    @Query('userId') userId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    if (!this.conn.isConnected) return DISABLED_RESPONSE;

    const pg = safePagination(page, limit);
    const filter: Record<string, any> = {};
    if (routeKey) filter.routeKey = sanitizeString(routeKey);
    const parsedStatusCode = parseOptionalInteger(statusCode, 'statusCode');
    if (parsedStatusCode !== undefined) filter.statusCode = parsedStatusCode;
    const parsedMinDuration = parseOptionalInteger(
      minDuration,
      'minDuration',
      0,
    );
    if (parsedMinDuration !== undefined) {
      filter.duration = { $gte: parsedMinDuration };
    }
    if (userId) filter.userId = sanitizeString(userId);
    if (from || to) {
      filter.timestamp = {};
      const fromDate = parseOptionalDate(from, 'from');
      const toDate = parseOptionalDate(to, 'to');
      if (fromDate) filter.timestamp.$gte = fromDate;
      if (toDate) filter.timestamp.$lte = toDate;
    }

    const [data, total] = await Promise.all([
      this.conn.requestLog
        .find(filter)
        .sort({ timestamp: -1 })
        .skip(pg.skip)
        .limit(pg.limit)
        .lean(),
      this.conn.requestLog.countDocuments(filter),
    ]);

    return { data, meta: { total, page: pg.page, limit: pg.limit } };
  }

  @Get('requests/stats')
  @ApiOperation({ summary: 'Get aggregated route performance stats' })
  @ApiQuery({ name: 'sortBy', required: false, enum: ALLOWED_STATS_SORT })
  async getRequestStats(@Query('sortBy') sortBy = 'p95Duration') {
    if (!this.conn.isConnected) return DISABLED_RESPONSE;

    const safeSortBy = ALLOWED_STATS_SORT.includes(sortBy)
      ? sortBy
      : 'p95Duration';

    const stats = await this.conn.requestStats
      .find()
      .sort({ [safeSortBy]: -1 })
      .limit(100)
      .lean();

    return { data: stats };
  }

  @Get('requests/routes/:routeKey')
  @ApiOperation({ summary: 'Get stats and recent logs for a specific route' })
  async getRouteDetail(
    @Param('routeKey') routeKey: string,
    @Query('limit') limit = '20',
  ) {
    if (!this.conn.isConnected) return DISABLED_RESPONSE;

    const safeRouteKey = sanitizeString(routeKey);
    const safeLimit = Math.min(
      MAX_LIMIT,
      Math.max(1, parseInt(limit, 10) || 20),
    );

    const [stats, recentLogs] = await Promise.all([
      this.conn.requestStats.findOne({ routeKey: safeRouteKey }).lean(),
      this.conn.requestLog
        .find({ routeKey: safeRouteKey })
        .sort({ timestamp: -1 })
        .limit(safeLimit)
        .lean(),
    ]);

    return { stats, recentLogs };
  }

  // ─── Query Logs ──────────────────────────────────────────

  @Get('queries')
  @ApiOperation({ summary: 'Get slow query logs' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'model', required: false })
  @ApiQuery({ name: 'minDuration', required: false })
  @ApiQuery({ name: 'n1Only', required: false })
  async getQueryLogs(
    @Query('page') page = '1',
    @Query('limit') limit = '50',
    @Query('model') model?: string,
    @Query('minDuration') minDuration?: string,
    @Query('n1Only') n1Only?: string,
  ) {
    if (!this.conn.isConnected) return DISABLED_RESPONSE;

    const pg = safePagination(page, limit);
    const filter: Record<string, any> = {};
    if (model) filter.modelName = sanitizeString(model);
    const parsedMinDuration = parseOptionalInteger(
      minDuration,
      'minDuration',
      0,
    );
    if (parsedMinDuration !== undefined) {
      filter.duration = { $gte: parsedMinDuration };
    }
    if (n1Only === 'true') filter.isN1 = true;

    const [data, total] = await Promise.all([
      this.conn.queryLog
        .find(filter)
        .sort({ timestamp: -1 })
        .skip(pg.skip)
        .limit(pg.limit)
        .lean(),
      this.conn.queryLog.countDocuments(filter),
    ]);

    return { data, meta: { total, page: pg.page, limit: pg.limit } };
  }

  @Get('queries/stats')
  @ApiOperation({ summary: 'Get per-model query performance stats' })
  async getQueryStats() {
    if (!this.conn.isConnected) return DISABLED_RESPONSE;

    const stats = await this.conn.queryStats
      .find()
      .sort({ avgDuration: -1 })
      .lean();

    return { data: stats };
  }

  @Get('queries/patterns')
  @ApiOperation({ summary: 'Get slow query patterns grouped by fingerprint' })
  async getQueryPatterns() {
    if (!this.conn.isConnected) return DISABLED_RESPONSE;

    const patterns = await this.conn.queryLog.aggregate([
      {
        $group: {
          _id: '$queryHash',
          queryShape: { $first: '$queryShape' },
          modelName: { $first: '$modelName' },
          operation: { $first: '$operation' },
          count: { $sum: 1 },
          avgDuration: { $avg: '$duration' },
          maxDuration: { $max: '$duration' },
          sourceFile: { $first: '$sourceFile' },
          sourceFunction: { $first: '$sourceFunction' },
          n1Count: { $sum: { $cond: ['$isN1', 1, 0] } },
          lastSeen: { $max: '$timestamp' },
        },
      },
      { $sort: { count: -1 } },
      { $limit: 50 },
    ]);

    return { data: patterns };
  }

  // ─── App Logs ────────────────────────────────────────────

  @Get('app')
  @ApiOperation({ summary: 'Get application logs' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'context', required: false })
  @ApiQuery({
    name: 'level',
    required: false,
    enum: ['debug', 'info', 'warn', 'error'],
  })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  async getAppLogs(
    @Query('page') page = '1',
    @Query('limit') limit = '50',
    @Query('context') context?: string,
    @Query('level') level?: string,
    @Query('search') search?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    if (!this.conn.isConnected) return DISABLED_RESPONSE;

    const pg = safePagination(page, limit);
    const validLevels = ['debug', 'info', 'warn', 'error'];
    const filter: Record<string, any> = {};
    if (context) filter.context = sanitizeString(context);
    if (level && validLevels.includes(level)) filter.level = level;
    if (search) filter.$text = { $search: sanitizeString(search) };
    if (from || to) {
      filter.timestamp = {};
      const fromDate = parseOptionalDate(from, 'from');
      const toDate = parseOptionalDate(to, 'to');
      if (fromDate) filter.timestamp.$gte = fromDate;
      if (toDate) filter.timestamp.$lte = toDate;
    }

    const [data, total] = await Promise.all([
      this.conn.appLog
        .find(filter)
        .sort({ timestamp: -1 })
        .skip(pg.skip)
        .limit(pg.limit)
        .lean(),
      this.conn.appLog.countDocuments(filter),
    ]);

    return { data, meta: { total, page: pg.page, limit: pg.limit } };
  }

  // ─── Cron Logs ───────────────────────────────────────────

  @Get('crons')
  @ApiOperation({
    summary: 'Get all registered cron jobs with stats and next run time',
  })
  @ApiQuery({ name: 'category', required: false })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: [
      'success',
      'error',
      'completed_with_errors',
      'skipped',
      'running',
      'timeout',
    ],
  })
  async getCrons(
    @Query('category') category?: string,
    @Query('status') status?: string,
  ) {
    if (!this.conn.isConnected) return DISABLED_RESPONSE;

    const filter: Record<string, any> = {};
    if (category) filter.category = sanitizeString(category);
    if (status) filter.lastRunStatus = status;

    const crons = await this.conn.cronConfig
      .find(filter)
      .sort({ category: 1, cronName: 1 })
      .lean();

    // Enrich with nextRunAt from live CronJob instances
    const nextRunTimes = this.cronService.getAllNextRunTimes();
    const enriched = crons.map((cron) => ({
      ...cron,
      nextRunAt: nextRunTimes[cron.cronName] || null,
    }));

    return { data: enriched };
  }

  @Get('crons/categories')
  @ApiOperation({ summary: 'Get cron job counts grouped by category' })
  async getCronCategories() {
    if (!this.conn.isConnected) return DISABLED_RESPONSE;

    const categories = await this.conn.cronConfig.aggregate([
      {
        $group: {
          _id: '$category',
          total: { $sum: 1 },
          enabled: { $sum: { $cond: ['$isEnabled', 1, 0] } },
          disabled: { $sum: { $cond: ['$isEnabled', 0, 1] } },
          healthy: {
            $sum: {
              $cond: [{ $eq: ['$lastRunStatus', 'success'] }, 1, 0],
            },
          },
          failing: {
            $sum: {
              $cond: [{ $eq: ['$lastRunStatus', 'error'] }, 1, 0],
            },
          },
          withErrors: {
            $sum: {
              $cond: [
                { $eq: ['$lastRunStatus', 'completed_with_errors'] },
                1,
                0,
              ],
            },
          },
          totalRuns: { $sum: '$runCount' },
          totalErrors: { $sum: '$errorCount' },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    return {
      data: categories.map((c) => ({
        category: c._id || 'uncategorized',
        ...c,
        _id: undefined,
      })),
    };
  }

  @Get('crons/:name')
  @ApiOperation({ summary: 'Get a single cron config with next run time' })
  async getCron(@Param('name') name: string) {
    if (!this.conn.isConnected) return DISABLED_RESPONSE;

    const safeName = sanitizeString(name);
    const config = await this.conn.cronConfig
      .findOne({ cronName: safeName })
      .lean();

    if (!config) return { data: null, message: 'Cron not found' };

    return {
      data: {
        ...config,
        nextRunAt: this.cronService.getNextRunTime(safeName),
      },
    };
  }

  @Get('crons/:name/logs')
  @ApiOperation({ summary: 'Get logs for a specific cron job' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'runId', required: false })
  @ApiQuery({ name: 'level', required: false })
  async getCronLogs(
    @Param('name') name: string,
    @Query('page') page = '1',
    @Query('limit') limit = '50',
    @Query('runId') runId?: string,
    @Query('level') level?: string,
  ) {
    if (!this.conn.isConnected) return DISABLED_RESPONSE;

    const pg = safePagination(page, limit);
    const filter: Record<string, any> = { cronName: sanitizeString(name) };
    if (runId) filter.runId = sanitizeString(runId);
    if (level) filter.level = level;

    const [data, total] = await Promise.all([
      this.conn.cronLog
        .find(filter)
        .sort({ timestamp: -1 })
        .skip(pg.skip)
        .limit(pg.limit)
        .lean(),
      this.conn.cronLog.countDocuments(filter),
    ]);

    return { data, meta: { total, page: pg.page, limit: pg.limit } };
  }

  @Patch('crons/categories/:category')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Enable or disable all cron jobs in a category' })
  async updateCronCategory(
    @Param('category') category: string,
    @Body() body: unknown,
  ) {
    if (!this.conn.isConnected) return DISABLED_RESPONSE;

    const safeCategory = sanitizeString(category);
    const isEnabled = parseRequiredBoolean(body, 'isEnabled');
    const result = await this.conn.cronConfig.updateMany(
      { category: safeCategory },
      { $set: { isEnabled } },
    );

    return {
      data: {
        category: safeCategory,
        isEnabled,
        modifiedCount: result.modifiedCount,
      },
    };
  }

  @Patch('crons/:name')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Enable or disable a cron job' })
  async updateCron(@Param('name') name: string, @Body() body: unknown) {
    if (!this.conn.isConnected) return DISABLED_RESPONSE;

    const parsedBody = ensureObjectBody(body);
    const update: Record<string, any> = {};
    const isEnabled = parseOptionalBoolean(parsedBody, 'isEnabled');
    const description = parseOptionalString(parsedBody, 'description');

    if (isEnabled !== undefined) update.isEnabled = isEnabled;
    if (description !== undefined) update.description = description;

    if (Object.keys(update).length === 0) {
      throw new BadRequestException(
        'At least one of isEnabled or description is required',
      );
    }

    const config = await this.conn.cronConfig.findOneAndUpdate(
      { cronName: sanitizeString(name) },
      { $set: update },
      { new: true },
    );

    return { data: config };
  }

  // ─── Trace (Cross-Collection Correlation) ────────────────

  @Get('trace/:requestId')
  @ApiOperation({
    summary: 'Get all logs across all collections for a request ID',
  })
  async trace(@Param('requestId') requestId: string) {
    if (!this.conn.isConnected) return DISABLED_RESPONSE;

    const safeId = sanitizeString(requestId);

    const [requestLog, queryLogs, appLogs] = await Promise.all([
      this.conn.requestLog.findOne({ requestId: safeId }).lean(),
      this.conn.queryLog
        .find({ requestId: safeId })
        .sort({ timestamp: 1 })
        .lean(),
      this.conn.appLog
        .find({ requestId: safeId })
        .sort({ timestamp: 1 })
        .lean(),
    ]);

    return {
      requestId: safeId,
      request: requestLog,
      queries: queryLogs,
      appLogs,
    };
  }
}
