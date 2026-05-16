import { Schema, Document } from 'mongoose';

export interface ICronConfig extends Document {
  cronName: string;
  displayName: string;
  description?: string;
  category?: string;
  schedule: string;
  isEnabled: boolean;
  lastRunAt?: Date;
  lastRunStatus?:
    | 'success'
    | 'error'
    | 'completed_with_errors'
    | 'skipped'
    | 'running'
    | 'timeout';
  lastRunDuration?: number;
  lastError?: string;
  runCount: number;
  errorCount: number;
  consecutiveFailures: number;
  createdAt: Date;
  updatedAt: Date;
}

export function createCronConfigSchema() {
  const schema = new Schema<ICronConfig>(
    {
      cronName: { type: String, required: true, unique: true },
      displayName: { type: String, required: true },
      description: { type: String },
      category: { type: String, index: true },
      schedule: { type: String, required: true },
      isEnabled: { type: Boolean, default: true },
      lastRunAt: { type: Date },
      lastRunStatus: {
        type: String,
        enum: [
          'success',
          'error',
          'completed_with_errors',
          'skipped',
          'running',
          'timeout',
        ],
      },
      lastRunDuration: { type: Number },
      lastError: { type: String },
      runCount: { type: Number, default: 0 },
      errorCount: { type: Number, default: 0 },
      consecutiveFailures: { type: Number, default: 0 },
    },
    { collection: 'cron_configs', timestamps: true },
  );

  schema.index({ category: 1, cronName: 1 });

  return schema;
}
