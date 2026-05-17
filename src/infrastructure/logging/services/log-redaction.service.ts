// Exact matches (after lowercasing and stripping hyphens/underscores)
const SENSITIVE_EXACT = new Set([
  'password',
  'token',
  'secret',
  'key',
  'auth',
  'authorization',
  'cookie',
  'credit',
  'cvv',
  'cvc',
  'pin',
  'otp',
  'ssn',
  'bvn',
  'nin',
  'accesstoken',
  'refreshtoken',
  'apikey',
  'private',
  'creditcard',
  'cardnumber',
  'securitycode',
  'sessionid',
]);

// Substring patterns — if ANY of these appear within the normalized key, redact it.
// Catches variants like passwordHash, tokenSecret, privateKey, jwtToken, etc.
const SENSITIVE_SUBSTRINGS = [
  'password',
  'secret',
  'token',
  'private',
  'credential',
];

const MAX_STRING_LENGTH = 1024;
const MAX_DEPTH = 5;

/**
 * Redacts sensitive data from objects before logging.
 * Handles nested objects, arrays, and circular references.
 */
export function redact(obj: any, depth = 0, seen = new WeakSet()): any {
  if (obj === null || obj === undefined) return obj;

  if (typeof obj === 'string') {
    return obj.length > MAX_STRING_LENGTH
      ? obj.slice(0, MAX_STRING_LENGTH) + '...[truncated]'
      : obj;
  }

  if (typeof obj !== 'object') return obj;

  if (depth >= MAX_DEPTH) return '[max depth]';

  const ref = obj as object;

  // Circular reference detection
  if (seen.has(ref)) return '[circular]';
  seen.add(ref);

  if (Array.isArray(obj)) {
    return obj.map((item) => redact(item, depth + 1, seen));
  }

  const redacted: Record<string, any> = {};
  for (const [key, value] of Object.entries(ref as Record<string, unknown>)) {
    const lowerKey = key.toLowerCase().replace(/[-_]/g, '');
    if (
      SENSITIVE_EXACT.has(lowerKey) ||
      SENSITIVE_SUBSTRINGS.some((sub) => lowerKey.includes(sub))
    ) {
      redacted[key] = '[REDACTED]';
    } else {
      redacted[key] = redact(value, depth + 1, seen);
    }
  }

  return redacted;
}

/**
 * Normalize a request path by replacing dynamic segments with :id.
 * e.g., /api/v1/users/abc-123/posts/456 → /api/v1/users/:id/posts/:id
 */
export function normalizePath(path: string): string {
  return path
    .replace(
      /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      '/:id',
    ) // UUIDs
    .replace(/\/\d+/g, '/:id') // Numeric IDs
    .replace(/\/[0-9a-f]{24}/gi, '/:id'); // MongoDB ObjectIds
}

/**
 * Infer user type from the request path.
 */
export function inferUserType(path: string): string {
  if (/\/admin\//i.test(path)) return 'admin';
  if (/\/merchant\//i.test(path)) return 'merchant';
  if (/\/agent\//i.test(path)) return 'agent';
  if (/\/lender\//i.test(path)) return 'lender';
  if (/\/(user|app|customer)\//i.test(path)) return 'customer';
  return 'anonymous';
}
