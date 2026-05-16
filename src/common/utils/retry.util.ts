import { Logger } from '@nestjs/common';

const logger = new Logger('Retry');

export interface RetryOptions {
  /** Maximum number of attempts (default: 3) */
  maxAttempts?: number;
  /** Base delay in ms between retries (default: 1000) */
  delayMs?: number;
  /** Multiplier for exponential backoff (default: 2) */
  backoffMultiplier?: number;
  /** Maximum delay in ms (default: 30000) */
  maxDelayMs?: number;
  /** Function to determine if the error is retryable (default: all errors) */
  retryIf?: (error: Error) => boolean;
  /** Label for logging */
  label?: string;
}

/**
 * Retries a function with exponential backoff.
 *
 * Usage:
 *   const result = await retry(
 *     () => this.httpService.get('https://api.example.com/data'),
 *     { maxAttempts: 3, delayMs: 500, label: 'FetchExternalData' }
 *   );
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxAttempts = 3,
    delayMs = 1000,
    backoffMultiplier = 2,
    maxDelayMs = 30000,
    retryIf = () => true,
    label = 'operation',
  } = options;

  let lastError: Error;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      if (attempt === maxAttempts || !retryIf(lastError)) {
        logger.error(
          `${label} failed after ${attempt} attempt(s): ${lastError.message}`,
        );
        throw lastError;
      }

      const delay = Math.min(
        delayMs * Math.pow(backoffMultiplier, attempt - 1),
        maxDelayMs,
      );

      logger.warn(
        `${label} attempt ${attempt}/${maxAttempts} failed: ${lastError.message}. Retrying in ${delay}ms...`,
      );

      await sleep(delay);
    }
  }

  throw lastError!;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
