import { Schema, Document } from 'mongoose';

export interface IQueryLog extends Document {
  requestId?: string;
  modelName: string;
  operation: string;
  duration: number;
  query?: string;
  queryShape?: string;
  queryHash?: string;
  sourceFile?: string;
  sourceLine?: number;
  sourceFunction?: string;
  sourceStack?: string[];
  isN1?: boolean;
  timestamp: Date;
}

export function createQueryLogSchema(ttlHours: number) {
  const schema = new Schema<IQueryLog>(
    {
      requestId: { type: String, index: true },
      modelName: { type: String, required: true },
      operation: { type: String, required: true },
      duration: { type: Number, required: true },
      query: { type: String },
      queryShape: { type: String },
      queryHash: { type: String, index: true },
      sourceFile: { type: String },
      sourceLine: { type: Number },
      sourceFunction: { type: String },
      sourceStack: [{ type: String }],
      isN1: { type: Boolean, default: false },
      timestamp: { type: Date, default: Date.now, index: true },
    },
    { collection: 'query_logs' },
  );

  schema.index({ modelName: 1, timestamp: -1 });
  schema.index({ duration: -1 });
  schema.index({ timestamp: 1 }, { expireAfterSeconds: ttlHours * 3600 });

  return schema;
}
