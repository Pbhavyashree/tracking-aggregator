/**
 * Circuit breaker.
 *
 * Retries help when a carrier is briefly unwell. They actively hurt when it is
 * properly down: every request burns its retry budget, holds a connection, and
 * makes the caller wait the full backoff sequence before failing anyway. Worse,
 * the retries themselves become the load preventing recovery.
 *
 * The breaker notices sustained failure and stops trying. Callers then fail
 * immediately with a clear reason instead of hanging, and the carrier gets
 * quiet enough to come back.
 *
 * Three states:
 *   closed    — normal. Failures are counted.
 *   open      — failing fast. No calls go through until the cooldown expires.
 *   half-open — one probe request. Success closes the circuit; failure
 *               reopens it for another cooldown.
 *
 * Half-open matters: without it, the breaker either stays open forever or
 * slams the full traffic back onto a service that may still be broken. One
 * probe is the cheapest possible question.
 */

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  /** Consecutive failures before the circuit opens. */
  failureThreshold?: number;
  /** How long to stay open before allowing a probe. */
  cooldownMs?: number;
  /** Successful probes needed to close again. */
  successThreshold?: number;
  /** Injected in tests so time can be controlled. */
  now?: () => number;
}

export class CircuitOpenError extends Error {
  constructor(readonly name_: string, readonly retryAfterMs: number) {
    super(
      `Circuit for "${name_}" is open; not calling it for another ${retryAfterMs}ms`,
    );
    this.name = 'CircuitOpenError';
  }
}

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures = 0;
  private successes = 0;
  private openedAt = 0;

  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly successThreshold: number;
  private readonly now: () => number;

  constructor(
    private readonly label: string,
    options: CircuitBreakerOptions = {},
  ) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.cooldownMs = options.cooldownMs ?? 30_000;
    this.successThreshold = options.successThreshold ?? 1;
    this.now = options.now ?? Date.now;
  }

  get currentState(): CircuitState {
    return this.state;
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    this.refreshState();

    if (this.state === 'open') {
      throw new CircuitOpenError(this.label, this.remainingCooldown());
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  /** Moves open -> half-open once the cooldown has elapsed. */
  private refreshState(): void {
    if (this.state === 'open' && this.remainingCooldown() <= 0) {
      this.state = 'half-open';
      this.successes = 0;
    }
  }

  private remainingCooldown(): number {
    return Math.max(0, this.openedAt + this.cooldownMs - this.now());
  }

  private onSuccess(): void {
    if (this.state === 'half-open') {
      this.successes += 1;
      if (this.successes >= this.successThreshold) {
        this.state = 'closed';
        this.failures = 0;
      }
      return;
    }

    // A success in the closed state clears the count: the threshold is about
    // *consecutive* failures, not failures ever seen.
    this.failures = 0;
  }

  private onFailure(): void {
    if (this.state === 'half-open') {
      // The probe failed, so the service is still unwell. Back to open, and
      // restart the cooldown rather than letting probes hammer it.
      this.trip();
      return;
    }

    this.failures += 1;
    if (this.failures >= this.failureThreshold) {
      this.trip();
    }
  }

  private trip(): void {
    this.state = 'open';
    this.openedAt = this.now();
    this.successes = 0;
  }

  /** Exposed for the health endpoint, so operators can see the state. */
  snapshot() {
    this.refreshState();
    return {
      carrier: this.label,
      state: this.state,
      consecutiveFailures: this.failures,
      retryAfterMs: this.state === 'open' ? this.remainingCooldown() : 0,
    };
  }
}
