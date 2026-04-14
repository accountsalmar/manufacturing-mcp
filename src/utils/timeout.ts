/**
 * Timeout utility for wrapping Promises with a maximum execution time.
 * Prevents API calls from hanging indefinitely.
 */

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/**
 * Wraps a Promise with a timeout. If the Promise doesn't resolve or reject
 * within the specified time, it will be rejected with a TimeoutError.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string = 'Operation timed out'
): Promise<T> {
  const timeoutPromise = new Promise<never>((_, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new TimeoutError(`${message} (after ${ms}ms)`));
    }, ms);

    promise.finally(() => clearTimeout(timeoutId));
  });

  return Promise.race([promise, timeoutPromise]);
}

/**
 * Default timeout values in milliseconds
 */
export const TIMEOUTS = {
  AUTH: 30000,
  API: 30000,
  LARGE_OPERATION: 60000,
  HEALTH_CHECK: 5000,
} as const;
