import { Schema, Document } from 'mongoose';

export interface IRequestLog extends Document {
  requestId: string;
  method: string;
  path: string;
  routeKey: string;
  statusCode: number;
  duration: number;
  requestSize: number;
  responseSize: number;
  ip: string;
  userAgent: string;
  userId?: string;
  userType?: string;
  requestQuery?: Record<string, any>;
  requestBody?: Record<string, any>;
  requestParams?: Record<string, any>;
  responseMessage?: string;
  responseSummary?: string;
  error?: {
    message: string;
    stack?: string;
    name?: string;
  };
  dbQueryCount: number;
  dbTotalDuration: number;
  dbSlowQueryCount: number;
  slowDbQueries?: {
    model: string;
    operation: string;
    duration: number;
  }[];
  spans?: {
    name: string;
    duration: number;
  }[];
  memoryDelta?: number;
  performanceHint?: string;
  timestamp: Date;
}

export function createRequestLogSchema(ttlHours: number) {
  const schema = new Schema<IRequestLog>(
    {
      requestId: { type: String, required: true, index: true },
      method: { type: String, required: true },
      path: { type: String, required: true },
      routeKey: { type: String, required: true },
      statusCode: { type: Number, required: true },
      duration: { type: Number, required: true },
      requestSize: { type: Number, default: 0 },
      responseSize: { type: Number, default: 0 },
      ip: { type: String },
      userAgent: { type: String },
      userId: { type: String },
      userType: { type: String },
      requestQuery: { type: Schema.Types.Mixed },
      requestBody: { type: Schema.Types.Mixed },
      requestParams: { type: Schema.Types.Mixed },
      responseMessage: { type: String },
      responseSummary: { type: String },
      error: {
        message: { type: String },
        stack: { type: String },
        name: { type: String },
      },
      dbQueryCount: { type: Number, default: 0 },
      dbTotalDuration: { type: Number, default: 0 },
      dbSlowQueryCount: { type: Number, default: 0 },
      slowDbQueries: [{ model: String, operation: String, duration: Number }],
      spans: [{ name: String, duration: Number }],
      memoryDelta: { type: Number },
      performanceHint: { type: String },
      timestamp: { type: Date, default: Date.now, index: true },
    },
    { collection: 'request_logs' },
  );

  schema.index({ routeKey: 1, timestamp: -1 });
  schema.index({ statusCode: 1, timestamp: -1 });
  schema.index({ duration: -1 });
  schema.index({ userId: 1, timestamp: -1 });
  schema.index({ timestamp: 1 }, { expireAfterSeconds: ttlHours * 3600 });

  return schema;
}
