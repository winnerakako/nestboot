import { Schema, Document } from 'mongoose';

export interface IQueryStats extends Document {
  modelName: string;
  operation: string;
  queryCount: number;
  totalDuration: number;
  avgDuration: number;
  minDuration: number;
  maxDuration: number;
  slowQueryCount: number;
  n1DetectionCount: number;
  lastQueryAt: Date;
  updatedAt: Date;
}

export function createQueryStatsSchema(ttlHours: number) {
  const schema = new Schema<IQueryStats>(
    {
      modelName: { type: String, required: true },
      operation: { type: String, required: true },
      queryCount: { type: Number, default: 0 },
      totalDuration: { type: Number, default: 0 },
      avgDuration: { type: Number, default: 0 },
      minDuration: { type: Number, default: 0 },
      maxDuration: { type: Number, default: 0 },
      slowQueryCount: { type: Number, default: 0 },
      n1DetectionCount: { type: Number, default: 0 },
      lastQueryAt: { type: Date },
      updatedAt: { type: Date, default: Date.now },
    },
    { collection: 'query_stats', timestamps: false },
  );

  schema.index({ modelName: 1, operation: 1 }, { unique: true });

  if (ttlHours > 0) {
    schema.index({ updatedAt: 1 }, { expireAfterSeconds: ttlHours * 3600 });
  }

  return schema;
}
