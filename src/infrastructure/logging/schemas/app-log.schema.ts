import { Schema, Document } from 'mongoose';

export interface IAppLog extends Document {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  context: string;
  requestId?: string;
  userId?: string;
  metadata?: Record<string, any>;
  error?: {
    message: string;
    stack?: string;
    name?: string;
  };
  timestamp: Date;
}

export function createAppLogSchema(ttlHours: number) {
  const schema = new Schema<IAppLog>(
    {
      level: {
        type: String,
        required: true,
        enum: ['debug', 'info', 'warn', 'error'],
        index: true,
      },
      message: { type: String, required: true },
      context: { type: String, required: true, index: true },
      requestId: { type: String, index: true },
      userId: { type: String, index: true },
      metadata: { type: Schema.Types.Mixed },
      error: {
        message: { type: String },
        stack: { type: String },
        name: { type: String },
      },
      timestamp: { type: Date, default: Date.now, index: true },
    },
    { collection: 'app_logs' },
  );

  schema.index({ context: 1, timestamp: -1 });
  schema.index({ level: 1, timestamp: -1 });
  schema.index({ message: 'text' });
  schema.index({ timestamp: 1 }, { expireAfterSeconds: ttlHours * 3600 });

  return schema;
}
