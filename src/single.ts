import type { Duration } from "./duration";
import { ms } from "./duration";
import type { Algorithm, RegionContext } from "./types";

import { Ratelimit } from "./ratelimit";
export type RegionRatelimitConfig = {
  /**
   * The ratelimiter function to use.
   *
   * Choose one of the predefined ones or implement your own.
   * Available algorithms are exposed via static methods:
   * - Ratelimiter.fixedWindow
   * - Ratelimiter.slidingWindow
   * - Ratelimiter.tokenBucket
   */
  limiter: Algorithm<RegionContext>;

  prefix?: string;

  /**
   * If enabled, the ratelimiter will keep a global cache of identifiers, that have
   * exhausted their ratelimit. In serverless environments this is only possible if
   * you create the ratelimiter instance outside of your handler function. While the
   * function is still hot, the ratelimiter can block requests without having to
   * request data from redis, thus saving time and money.
   *
   * Whenever an identifier has exceeded its limit, the ratelimiter will add it to an
   * internal list together with its reset timestamp. If the same identifier makes a
   * new request before it is reset, we can immediately reject it.
   *
   * Set to `false` to disable.
   *
   * If left undefined, a map is created automatically, but it can only work
   * if the map or the ratelimit instance is created outside your serverless function handler.
   */
  ephemeralCache?: Map<string, { value: number; expireAt?: number }> | false;

  /**
   * If set, the ratelimiter will allow requests to pass after this many milliseconds.
   *
   * Use this if you want to allow requests in case of network problems
   */
  timeout?: number;
};

export class RegionRatelimit extends Ratelimit<RegionContext> {
  constructor(config: RegionRatelimitConfig) {
    super({
      prefix: config.prefix,
      limiter: config.limiter,
      timeout: config.timeout,
      ephemeralCache: config.ephemeralCache,
      ctx: {},
    });
  }

  /**
   * Each request inside a fixed time increases a counter.
   * Once the counter reaches the maximum allowed number, all further requests are
   * rejected.
   *
   * **Pro:**
   *
   * - Newer requests are not starved by old ones.
   * - Low storage cost.
   *
   * **Con:**
   *
   * A burst of requests near the boundary of a window can result in a very
   * high request rate because two windows will be filled with requests quickly.
   *
   * @param tokens - How many requests a user can make in each time window.
   * @param window - A fixed timeframe
   */
  static fixedWindow(
    /**
     * How many requests are allowed per window.
     */
    tokens: number,
    /**
     * The duration in which `tokens` requests are allowed.
     */
    window: Duration
  ): Algorithm<RegionContext> {
    const windowDuration = ms(window);

    return async function (ctx: RegionContext, identifier: string) {
      const bucket = Math.floor(Date.now() / windowDuration);
      const key = [identifier, bucket].join(":");
      if (ctx.cache) {
        const { blocked, reset } = ctx.cache.isBlocked(identifier);
        if (blocked) {
          return {
            success: false,
            limit: tokens,
            remaining: 0,
            reset: reset,
            pending: Promise.resolve(),
          };
        }
        const usedTokensAfterUpdate = ctx.cache.incr(key);
        ctx.cache.expire(key, windowDuration);
        const success = usedTokensAfterUpdate <= tokens;

        const resetNew = (bucket + 1) * windowDuration;
        if (ctx.cache && !success) {
          ctx.cache.blockUntil(identifier, resetNew);
        }
        return {
          success,
          limit: tokens,
          remaining: Math.max(0, tokens - usedTokensAfterUpdate),
          reset,
          pending: Promise.resolve(),
        };
      }
      return {
        success: true,
        limit: tokens,
        remaining: 0,
        reset: 0,
        pending: Promise.resolve(),
      };
    };
  }

  /**
   * Combined approach of `slidingLogs` and `fixedWindow` with lower storage
   * costs than `slidingLogs` and improved boundary behavior by calculating a
   * weighted score between two windows.
   *
   * **Pro:**
   *
   * Good performance allows this to scale to very high loads.
   *
   * **Con:**
   *
   * Nothing major.
   *
   * @param tokens - How many requests a user can make in each time window.
   * @param window - The duration in which the user can max X requests.
   */
  static slidingWindow(
    /**
     * How many requests are allowed per window.
     */
    tokens: number,
    /**
     * The duration in which `tokens` requests are allowed.
     */
    window: Duration
  ): Algorithm<RegionContext> {
    const windowSize = ms(window);
    return async function (ctx: RegionContext, identifier: string) {
      const now = Date.now();

      const currentWindow = Math.floor(now / windowSize);
      const currentKey = [identifier, currentWindow].join(":");
      const previousWindow = currentWindow - 1;
      const previousKey = [identifier, previousWindow].join(":");
      let remaining = 0;
      if (ctx.cache) {
        let { blocked, reset } = ctx.cache.isBlocked(identifier);
        if (blocked) {
          return {
            success: false,
            limit: tokens,
            remaining: 0,
            reset: reset,
            pending: Promise.resolve(),
          };
        }
        let requestsInCurrentWindow = ctx.cache?.get(currentKey);
        if (!requestsInCurrentWindow) {
          requestsInCurrentWindow = 0;
        }
        let requestsInPreviousWindow = ctx.cache.get(previousKey);
        if (!requestsInPreviousWindow) {
          requestsInPreviousWindow = 0;
        }
        let percentageInCurrent = (now % currentWindow) / currentWindow;

        requestsInPreviousWindow = Math.floor(
          (1 - percentageInCurrent) * requestsInPreviousWindow
        );
        if (requestsInPreviousWindow + requestsInCurrentWindow >= tokens) {
          remaining = -1;
        }
        let newValue = ctx.cache.incr(currentKey);
        if (newValue === 1) {
          ctx.cache.expire(currentKey, windowSize * 2 + 1000);
        }
        remaining = tokens - (newValue + requestsInPreviousWindow);
        const success = remaining >= 0;
        reset = (currentWindow + 1) * windowSize;
        if (ctx.cache && !success) {
          ctx.cache.blockUntil(identifier, reset);
        }
        return {
          success,
          limit: tokens,
          remaining: Math.max(0, remaining),
          reset,
          pending: Promise.resolve(),
        };
      }
      return {
        success: true,
        limit: tokens,
        remaining: Math.max(0, remaining),
        reset: 0,
        pending: Promise.resolve(),
      };
    };
  }

  /**
   * You have a bucket filled with `{maxTokens}` tokens that refills constantly
   * at `{refillRate}` per `{interval}`.
   * Every request will remove one token from the bucket and if there is no
   * token to take, the request is rejected.
   *
   * **Pro:**
   *
   * - Bursts of requests are smoothed out and you can process them at a constant
   * rate.
   * - Allows to set a higher initial burst limit by setting `maxTokens` higher
   * than `refillRate`
   */
  static tokenBucket(
    /**
     * How many tokens are refilled per `interval`
     *
     * An interval of `10s` and refillRate of 5 will cause a new token to be added every 2 seconds.
     */
    refillRate: number,
    /**
     * The interval for the `refillRate`
     */
    interval: Duration,
    /**
     * Maximum number of tokens.
     * A newly created bucket starts with this many tokens.
     * Useful to allow higher burst limits.
     */
    maxTokens: number
  ): Algorithm<RegionContext> {
    //const intervalDuration = ms(interval);
    return async function (ctx: RegionContext, identifier: string) {
      if (ctx.cache) {
        const { blocked, reset } = ctx.cache.isBlocked(identifier);
        if (blocked) {
          return {
            success: false,
            limit: maxTokens,
            remaining: 0,
            reset: reset,
            pending: Promise.resolve(),
          };
        }
      }

      //const now = Date.now();
      //TODO: implementation via the cache
      const remaining = 0;
      const reset = 0;
      // const [remaining, reset] = (await ctx.redis.eval(
      //   script,
      //   [identifier],
      //   [maxTokens, intervalDuration, refillRate, now]
      // )) as [number, number];

      const success = remaining >= 0;
      if (ctx.cache && !success) {
        ctx.cache.blockUntil(identifier, reset);
      }

      return {
        success,
        limit: maxTokens,
        remaining,
        reset,
        pending: Promise.resolve(),
      };
    };
  }

  /**
   * cachedFixedWindow first uses the local cache to decide if a request may pass and then updates
   * it asynchronously.
   * This is experimental and not yet recommended for production use.
   *
   * @experimental
   *
   * Each request inside a fixed time increases a counter.
   * Once the counter reaches the maximum allowed number, all further requests are
   * rejected.
   *
   * **Pro:**
   *
   * - Newer requests are not starved by old ones.
   * - Low storage cost.
   *
   * **Con:**
   *
   * A burst of requests near the boundary of a window can result in a very
   * high request rate because two windows will be filled with requests quickly.
   *
   * @param tokens - How many requests a user can make in each time window.
   * @param window - A fixed timeframe
   */
  static cachedFixedWindow(
    /**
     * How many requests are allowed per window.
     */
    tokens: number,
    /**
     * The duration in which `tokens` requests are allowed.
     */
    window: Duration
  ): Algorithm<RegionContext> {
    const windowDuration = ms(window);

    return async function (ctx: RegionContext, identifier: string) {
      if (!ctx.cache) {
        throw new Error("This algorithm requires a cache");
      }
      const bucket = Math.floor(Date.now() / windowDuration);
      const key = [identifier, bucket].join(":");
      const reset = (bucket + 1) * windowDuration;

      const hit = typeof ctx.cache.get(key) === "number";
      if (hit) {
        const cachedTokensAfterUpdate = ctx.cache.incr(key);
        const success = cachedTokensAfterUpdate < tokens;

        const pending = Promise.resolve();
        // const pending = success
        //   ? ctx.redis.eval(script, [key], [windowDuration]).then((t) => {
        //       ctx.cache!.set(key, t as number);
        //     })
        //   : Promise.resolve();

        return {
          success,
          limit: tokens,
          remaining: tokens - cachedTokensAfterUpdate,
          reset: reset,
          pending,
        };
      }
      //TODO: implementation via the cache

      const usedTokensAfterUpdate = 0;
      // const usedTokensAfterUpdate = (await ctx.redis.eval(
      //   script,
      //   [key],
      //   [windowDuration]
      // )) as number;
      ctx.cache.set(key, usedTokensAfterUpdate);
      const remaining = tokens - usedTokensAfterUpdate;

      return {
        success: remaining >= 0,
        limit: tokens,
        remaining,
        reset: reset,
        pending: Promise.resolve(),
      };
    };
  }
}
