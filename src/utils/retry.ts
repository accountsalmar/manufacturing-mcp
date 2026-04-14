/**
 * Retry utility with exponential backoff for transient failures.
 * Provides resilience against temporary network issues and server errors.
 */

// Network/server errors that should trigger retry
const RETRYABLE_PATTERNS = [
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH',
  'socket hang up', 'ENOTFOUND',
  '500', '502', '503', '504',  // HTTP 5xx server errors
  'Traceback',                  // Odoo Python errors (indicates server crash)
];

// Client errors that should NOT be retried (4xx-like errors)
const NON_RETRYABLE_PATTERNS = [
  'Invalid credentials', 'Access Denied', 'Forbidden',
  'unknown field', 'does not have attribute',
  'invalid literal',
];

/**
 * Determines if an error is retryable based on error message patterns.
 */
function isRetryableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);

  for (const pattern of NON_RETRYABLE_PATTERNS) {
    if (message.includes(pattern)) return false;
  }

  for (const pattern of RETRYABLE_PATTERNS) {
    if (message.includes(pattern)) return true;
  }

  return false;
}

/**
 * Executes a function with automatic retry and exponential backoff.
 */
export async function executeWithRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelayMs: number = 1000
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (!isRetryableError(error) || attempt === maxRetries) {
        throw error;
      }

      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      console.error(
        `[Retry ${attempt}/${maxRetries}] ${error instanceof Error ? error.message : error}. Waiting ${delay}ms...`
      );
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
