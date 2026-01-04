type CacheOpts = {
  ttlMs?: number;
};

export function cached<T>(fn: () => Promise<T>, opts?: CacheOpts) {
  const { ttlMs = 60 * 60 * 1000 } = opts || {};
  let cache: { time: number; value: T } | null = null;
  let timeoutId: NodeJS.Timeout | null = null;

  function invalidate() {
    cache = null;
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    timeoutId = null;
  }

  async function get() {
    const now = Date.now();
    if (cache && now - cache.time < ttlMs) {
      return cache.value;
    }
    const value = await fn();
    cache = { time: now, value };
    timeoutId = setTimeout(invalidate, ttlMs);
    return value;
  }

  return {
    invalidate,
    get,
  };
}

export function createCacheRecord<T, K extends number | string | symbol>(
  fn: (key: K) => Promise<T>,
  opts?: CacheOpts,
) {
  const caches = new Map<K, ReturnType<typeof cached<T>>>();

  return (key: K) => {
    const cache = caches.get(key) ?? cached(() => fn(key), opts);

    if (!caches.has(key)) {
      caches.set(key, cache);
    }

    return cache;
  };
}
