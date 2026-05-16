import { registerAs } from '@nestjs/config';

export default registerAs('logging', () => ({
  mongoUri: process.env.MONGO_LOG_URI || '',
  enabled: !!process.env.MONGO_LOG_URI,

  // TTLs in hours
  ttl: {
    requestLogs: parseInt(process.env.LOG_TTL_REQUEST || '48', 10),
    requestStats: parseInt(process.env.LOG_TTL_REQUEST_STATS || '2160', 10),
    queryLogs: parseInt(process.env.LOG_TTL_QUERY || '48', 10),
    queryStats: parseInt(process.env.LOG_TTL_QUERY_STATS || '2160', 10),
    appLogs: parseInt(process.env.LOG_TTL_APP || '720', 10),
    cronLogs: parseInt(process.env.LOG_TTL_CRON || '168', 10),
  },

  // Sampling rates (0.0 - 1.0)
  sampling: {
    requestRate: parseFloat(process.env.LOG_SAMPLE_RATE || '1.0'),
    errorRate: parseFloat(process.env.LOG_SAMPLE_ERROR_RATE || '1.0'),
    slowRate: parseFloat(process.env.LOG_SAMPLE_SLOW_RATE || '1.0'),
    slowThresholdMs: parseInt(process.env.LOG_SLOW_THRESHOLD || '1000', 10),
  },

  // Query monitoring
  query: {
    slowThresholdMs: parseInt(
      process.env.LOG_QUERY_SLOW_THRESHOLD || '100',
      10,
    ),
    sampleRate: parseFloat(process.env.LOG_QUERY_SAMPLE_RATE || '1.0'),
  },

  // Buffer flush intervals in ms
  buffer: {
    flushIntervalMs: parseInt(process.env.LOG_FLUSH_INTERVAL || '5000', 10),
    aggregationIntervalMs: parseInt(
      process.env.LOG_AGGREGATION_INTERVAL || '300000',
      10,
    ),
  },
}));
