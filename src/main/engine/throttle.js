'use strict';

/**
 * Debt-based token bucket. Callers report bytes they just received; when the
 * bucket goes negative they wait long enough to pay the debt back. Works for
 * any chunk size and is shared fairly across all connections that use it.
 */
class Throttle {
  constructor(bytesPerSecond = 0) {
    this.rate = 0;
    this.tokens = 0;
    this.last = Date.now();
    this.setRate(bytesPerSecond);
  }

  setRate(bytesPerSecond) {
    this.rate = Math.max(0, Number(bytesPerSecond) || 0);
    this.tokens = Math.min(this.tokens, this.rate);
    this.last = Date.now();
  }

  take(n) {
    if (!this.rate) return null;
    const now = Date.now();
    this.tokens = Math.min(this.rate, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    this.tokens -= n;
    if (this.tokens >= 0) return null;
    const waitMs = (-this.tokens / this.rate) * 1000;
    return new Promise((r) => setTimeout(r, Math.min(waitMs, 5000)));
  }
}

module.exports = { Throttle };
