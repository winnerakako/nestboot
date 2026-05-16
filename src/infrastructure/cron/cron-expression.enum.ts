/**
 * Pre-defined cron schedule expressions.
 * Use instead of raw strings to prevent typos.
 *
 * Usage:
 *   this.cron.register({
 *     name: 'sync-payments',
 *     schedule: CronExpression.EVERY_5_MINUTES,
 *   }, async (log) => { ... });
 */
export enum CronExpression {
  EVERY_SECOND = '* * * * * *',
  EVERY_5_SECONDS = '*/5 * * * * *',
  EVERY_10_SECONDS = '*/10 * * * * *',
  EVERY_30_SECONDS = '*/30 * * * * *',

  EVERY_MINUTE = '*/1 * * * *',
  EVERY_2_MINUTES = '*/2 * * * *',
  EVERY_3_MINUTES = '*/3 * * * *',
  EVERY_5_MINUTES = '*/5 * * * *',
  EVERY_10_MINUTES = '*/10 * * * *',
  EVERY_15_MINUTES = '*/15 * * * *',
  EVERY_20_MINUTES = '*/20 * * * *',
  EVERY_30_MINUTES = '*/30 * * * *',

  EVERY_HOUR = '0 * * * *',
  EVERY_2_HOURS = '0 */2 * * *',
  EVERY_3_HOURS = '0 */3 * * *',
  EVERY_4_HOURS = '0 */4 * * *',
  EVERY_6_HOURS = '0 */6 * * *',
  EVERY_8_HOURS = '0 */8 * * *',
  EVERY_12_HOURS = '0 */12 * * *',

  EVERY_DAY_AT_MIDNIGHT = '0 0 * * *',
  EVERY_DAY_AT_1AM = '0 1 * * *',
  EVERY_DAY_AT_2AM = '0 2 * * *',
  EVERY_DAY_AT_3AM = '0 3 * * *',
  EVERY_DAY_AT_4AM = '0 4 * * *',
  EVERY_DAY_AT_5AM = '0 5 * * *',
  EVERY_DAY_AT_6AM = '0 6 * * *',
  EVERY_DAY_AT_8AM = '0 8 * * *',
  EVERY_DAY_AT_NOON = '0 12 * * *',
  EVERY_DAY_AT_6PM = '0 18 * * *',

  EVERY_WEEK = '0 0 * * 0',
  EVERY_WEEKDAY = '0 0 * * 1-5',
  EVERY_MONDAY = '0 0 * * 1',
  EVERY_FRIDAY = '0 0 * * 5',

  EVERY_MONTH = '0 0 1 * *',
  EVERY_QUARTER = '0 0 1 */3 *',
  EVERY_YEAR = '0 0 1 1 *',
}
