import { Schema, Document } from 'mongoose';

export interface IRequestStats extends Document {
  routeKey: string;
  method: string;
  path: string;
  requestCount: number;
  errorCount: number;
  avgDuration: number;
  minDuration: number;
  maxDuration: number;
  p50Duration: number;
  p95Duration: number;
  p99Duration: number;
  lastStatusCode: number;
  lastRequestAt: Date;
  updatedAt: Date;
}

export function createRequestStatsSchema(ttlHours: number) {
  const schema = new Schema<IRequestStats>(
    {
      routeKey: { type: String, required: true, unique: true },
      method: { type: String, required: true },
      path: { type: String, required: true },
      requestCount: { type: Number, default: 0 },
      errorCount: { type: Number, default: 0 },
      avgDuration: { type: Number, default: 0 },
      minDuration: { type: Number, default: 0 },
      maxDuration: { type: Number, default: 0 },
      p50Duration: { type: Number, default: 0 },
      p95Duration: { type: Number, default: 0 },
      p99Duration: { type: Number, default: 0 },
      lastStatusCode: { type: Number },
      lastRequestAt: { type: Date },
      updatedAt: { type: Date, default: Date.now },
    },
    { collection: 'request_stats', timestamps: false },
  );

  if (ttlHours > 0) {
    schema.index({ updatedAt: 1 }, { expireAfterSeconds: ttlHours * 3600 });
  }

  return schema;
}
