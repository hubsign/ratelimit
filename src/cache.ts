import { EphemeralCache } from "./types";

export class Cache implements EphemeralCache {
  /**
   * Stores identifier -> reset (in milliseconds)
   */
  private readonly cache: Map<string, { value: number; expireAt?: number }>;

  constructor(cache: Map<string, { value: number; expireAt?: number }>) {
    this.cache = cache;
  }

  public isBlocked(identifier: string): { blocked: boolean; reset: number } {
    if (!this.cache.has(identifier)) {
      return { blocked: false, reset: 0 };
    }
    const reset = this.cache.get(identifier)!.value;
    if (reset < Date.now()) {
      this.cache.delete(identifier);
      return { blocked: false, reset: 0 };
    }

    return { blocked: true, reset: reset };
  }

  public blockUntil(identifier: string, reset: number): void {
    this.cache.set(identifier, { value: reset });
  }

  public set(key: string, value: number): void {
    this.cache.set(key, {
      value,
      expireAt: this.cache.get(key)?.expireAt ?? 0,
    });
  }
  public get(key: string): number | null {
    return this.cache.get(key)?.value || null;
  }

  public incr(key: string): number {
    this.cleanup();
    let value = this.cache.get(key)?.value ?? 0;
    value += 1;
    this.set(key, value);
    return value;
  }
  public expire(key: string, duration: number): void {
    this.cache.set(key, {
      value: this.cache.get(key)!.value,
      expireAt: Date.now() + duration,
    });
  }
  public cleanup() {
    const now = Date.now();
    for (let [key, { expireAt }] of this.cache.entries()) {
      if (expireAt) {
        if (now >= expireAt) {
          this.cache.delete(key);
        }
      }
    }
  }
}
