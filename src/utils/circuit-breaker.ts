/**
 * Circuit Breaker Pattern for graceful degradation when Odoo is unavailable.
 *
 * CLOSED (Normal): Requests flow through. Failures increment counter.
 *   If failures reach threshold (5), trip → OPEN
 *
 * OPEN (Failing Fast): All requests immediately fail.
 *   After reset timeout (60s), transition → HALF_OPEN
 *
 * HALF_OPEN (Testing Recovery): Allow ONE test request.
 *   If succeeds → CLOSED. If fails → OPEN.
 */

export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN'
}

export class CircuitBreakerError extends Error {
  public readonly secondsUntilRetry: number;

  constructor(message: string, secondsUntilRetry: number = 0) {
    super(message);
    this.name = 'CircuitBreakerError';
    this.secondsUntilRetry = secondsUntilRetry;
  }
}

export interface CircuitBreakerMetrics {
  state: CircuitState;
  failureCount: number;
  successCount: number;
  lastFailureTime: number | null;
  lastStateChange: number | null;
  secondsUntilHalfOpen: number | null;
}

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount: number = 0;
  private successCount: number = 0;
  private lastFailureTime: number | null = null;
  private lastStateChange: number | null = null;
  private halfOpenAttempts: number = 0;

  constructor(
    private readonly failureThreshold: number = 5,
    private readonly resetTimeoutMs: number = 60000,
    private readonly halfOpenMaxAttempts: number = 1
  ) {}

  getState(): CircuitState {
    return this.state;
  }

  getMetrics(): CircuitBreakerMetrics {
    let secondsUntilHalfOpen: number | null = null;

    if (this.state === CircuitState.OPEN && this.lastFailureTime !== null) {
      const elapsed = Date.now() - this.lastFailureTime;
      const remaining = this.resetTimeoutMs - elapsed;
      secondsUntilHalfOpen = remaining > 0 ? Math.ceil(remaining / 1000) : 0;
    }

    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastFailureTime: this.lastFailureTime,
      lastStateChange: this.lastStateChange,
      secondsUntilHalfOpen
    };
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === CircuitState.OPEN) {
      if (this.shouldTransitionToHalfOpen()) {
        this.transitionTo(CircuitState.HALF_OPEN);
        this.halfOpenAttempts = 0;
      } else {
        const secondsUntilRetry = this.getSecondsUntilHalfOpen();
        throw new CircuitBreakerError(
          `Odoo service temporarily unavailable. Connection will be retried in ${secondsUntilRetry} seconds.`,
          secondsUntilRetry
        );
      }
    }

    if (this.state === CircuitState.HALF_OPEN) {
      if (this.halfOpenAttempts >= this.halfOpenMaxAttempts) {
        throw new CircuitBreakerError(
          'Odoo service recovery test in progress. Please wait.',
          5
        );
      }
      this.halfOpenAttempts++;
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  reset(): void {
    console.error(`[CircuitBreaker] Manual reset from ${this.state} to CLOSED`);
    this.transitionTo(CircuitState.CLOSED);
    this.failureCount = 0;
    this.halfOpenAttempts = 0;
  }

  private onSuccess(): void {
    this.successCount++;

    if (this.state === CircuitState.HALF_OPEN) {
      console.error('[CircuitBreaker] Recovery successful! Closing circuit.');
      this.transitionTo(CircuitState.CLOSED);
      this.failureCount = 0;
      this.halfOpenAttempts = 0;
    } else if (this.state === CircuitState.CLOSED) {
      this.failureCount = 0;
    }
  }

  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === CircuitState.HALF_OPEN) {
      console.error('[CircuitBreaker] Recovery test failed. Reopening circuit.');
      this.transitionTo(CircuitState.OPEN);
      this.halfOpenAttempts = 0;
    } else if (this.state === CircuitState.CLOSED) {
      if (this.failureCount >= this.failureThreshold) {
        console.error(
          `[CircuitBreaker] Failure threshold reached (${this.failureCount}/${this.failureThreshold}). Opening circuit.`
        );
        this.transitionTo(CircuitState.OPEN);
      } else {
        console.error(
          `[CircuitBreaker] Failure ${this.failureCount}/${this.failureThreshold}`
        );
      }
    }
  }

  private shouldTransitionToHalfOpen(): boolean {
    if (this.lastFailureTime === null) return true;
    const elapsed = Date.now() - this.lastFailureTime;
    return elapsed >= this.resetTimeoutMs;
  }

  private getSecondsUntilHalfOpen(): number {
    if (this.lastFailureTime === null) return 0;
    const elapsed = Date.now() - this.lastFailureTime;
    const remaining = this.resetTimeoutMs - elapsed;
    return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
  }

  private transitionTo(newState: CircuitState): void {
    if (this.state !== newState) {
      console.error(`[CircuitBreaker] State: ${this.state} → ${newState}`);
      this.state = newState;
      this.lastStateChange = Date.now();
    }
  }
}
