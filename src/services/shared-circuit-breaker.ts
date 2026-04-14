/**
 * Shared Circuit Breaker for Connection Pool
 *
 * All pooled clients share a single circuit breaker:
 * - If Odoo is down for one client, it's down for all
 * - Prevents wasteful retry attempts across multiple clients
 * - Faster recovery detection (first success opens for all)
 */

import { CircuitBreaker, CircuitState, type CircuitBreakerMetrics } from '../utils/circuit-breaker.js';
import { CIRCUIT_BREAKER_CONFIG } from '../constants.js';

let sharedBreaker: CircuitBreaker | null = null;

export function getSharedCircuitBreaker(): CircuitBreaker {
  if (!sharedBreaker) {
    sharedBreaker = new CircuitBreaker(
      CIRCUIT_BREAKER_CONFIG.FAILURE_THRESHOLD,
      CIRCUIT_BREAKER_CONFIG.RESET_TIMEOUT_MS,
      CIRCUIT_BREAKER_CONFIG.HALF_OPEN_MAX_ATTEMPTS
    );
    console.error('[SharedCircuitBreaker] Created shared circuit breaker instance');
  }
  return sharedBreaker;
}

export function resetSharedCircuitBreaker(): void {
  if (sharedBreaker) {
    sharedBreaker.reset();
    console.error('[SharedCircuitBreaker] Reset to CLOSED state');
  }
}

export function getSharedCircuitBreakerState(): CircuitState {
  return getSharedCircuitBreaker().getState();
}

export function getSharedCircuitBreakerMetrics(): CircuitBreakerMetrics {
  return getSharedCircuitBreaker().getMetrics();
}
