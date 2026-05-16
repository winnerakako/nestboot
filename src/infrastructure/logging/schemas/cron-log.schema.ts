import { Schema, Document } from 'mongoose';

export interface ICronLog extends Document {
  cronName: string;
  runId: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  metadata?: Record<string, any>;
  duration?: number;
  status?:
    | 'success'
    | 'error'
    | 'completed_with_errors'
    | 'skipped'
    | 'timeout';
  timestamp: Date;
}

export function createCronLogSchema(ttlHours: number) {
  const schema = new Schema<ICronLog>(
    {
      cronName: { type: String, required: true, index: true },
      runId: { type: String, required: true, index: true },
      level: {
        type: String,
        required: true,
        enum: ['debug', 'info', 'warn', 'error'],
      },
      message: { type: String, required: true },
      metadata: { type: Schema.Types.Mixed },
      duration: { type: Number },
      status: {
        type: String,
        enum: [
          'success',
          'error',
          'completed_with_errors',
          'skipped',
          'timeout',
        ],
      },
      timestamp: { type: Date, default: Date.now, index: true },
    },
    { collection: 'cron_logs' },
  );

  schema.index({ cronName: 1, timestamp: -1 });
  schema.index({ runId: 1 });
  schema.index({ timestamp: 1 }, { expireAfterSeconds: ttlHours * 3600 });

  return schema;
}
