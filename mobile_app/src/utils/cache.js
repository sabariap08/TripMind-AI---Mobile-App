/**
 * Offline cache.
 *
 * A traveller on Indian rail or in a hill station queue loses signal at exactly
 * the moment they need their itinerary. This keeps the last-known-good copy of
 * the things they cannot afford to lose - their trips, the selected itinerary,
 * wallet balance, bookings - so the app opens to real content with no network
 * and says plainly that it is showing stale data.
 *
 * Three rules, because an offline cache that lies is worse than no cache:
 *
 *   1. Every entry carries the moment it was written. The UI shows that moment.
 *      "Updated 40 minutes ago" is honest; a silent stale read is not.
 *
 *   2. Writes are best-effort and never throw. A full disk must not break the
 *      request that produced the data.
 *
 *   3. Nothing sensitive is cached. Trips are the user's own itinerary and
 *      already readable from the account; the JWT stays in the keystore and is
 *      never written here. The cache is cleared on sign-out.
 *
 * Everything is namespaced per user id, so signing in as someone else on a
 * shared handset cannot surface the previous traveller's trips.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const PREFIX = 'tripmind.cache';
const MAX_AGE_MS = 1000 * 60 * 60 * 24 * 14; // two weeks

/** Keys we are willing to cache. Anything not here is never written. */
const ALLOWED = new Set([
  'trips',
  'trip',
  'itinerary',
  'budget',
  'wallet',
  'bookings',
  'events',
]);

const keyFor = (userId, name, id) =>
  `${PREFIX}.${userId || 'anon'}.${name}${id ? `.${id}` : ''}`;

/** Coerce anything that came out of storage into a usable envelope, or null. */
function revive(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.savedAt !== 'number') return null;
    return parsed;
  } catch {
    // Corrupt entry. Dropping it is the correct response; there is no partial
    // recovery that would be safe to render.
    return null;
  }
}

/**
 * Read a cached entry.
 *
 * Returns `null` when absent, corrupt, or older than `maxAgeMs`. Expiry is not
 * about data validity - the server is the authority on that - it is about not
 * showing a month-old itinerary as though it were current.
 */
export async function readCache(userId, name, id, { maxAgeMs = MAX_AGE_MS } = {}) {
  if (!ALLOWED.has(name)) return null;
  try {
    const entry = revive(await AsyncStorage.getItem(keyFor(userId, name, id)));
    if (!entry) return null;
    if (maxAgeMs !== Infinity && Date.now() - entry.savedAt > maxAgeMs) return null;
    return entry;
  } catch {
    return null;
  }
}

/** Read without the age gate. For debugging and for "show me the old one". */
export async function readCacheIgnoringAge(userId, name, id) {
  if (!ALLOWED.has(name)) return null;
  try {
    return revive(await AsyncStorage.getItem(keyFor(userId, name, id)));
  } catch {
    return null;
  }
}

/**
 * Write an entry. Returns true on success, false if it could not be written.
 *
 * Never throws. A cache failure is a performance problem, not a correctness
 * one, and the caller has already got its data.
 */
export async function writeCache(userId, name, id, data) {
  if (!ALLOWED.has(name)) return false;
  try {
    await AsyncStorage.setItem(
      keyFor(userId, name, id),
      JSON.stringify({ savedAt: Date.now(), data }),
    );
    return true;
  } catch {
    return false;
  }
}

export async function removeCache(userId, name, id) {
  if (!ALLOWED.has(name)) return false;
  try {
    await AsyncStorage.removeItem(keyFor(userId, name, id));
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetch, then cache on success. Returns the data either way.
 *
 * `cacheName`/`cacheId` are optional: a request that is not worth keeping (a
 * health check, a catalogue search) simply omits them and this degrades to a
 * plain network call.
 *
 * The one behaviour worth knowing: when the network call fails *and* something
 * is cached, the returned object carries `stale: true` and `savedAt`, instead of
 * throwing. Screens check `result.stale` and show a banner. Without that, every
 * screen would need its own try/catch around the same fallback.
 */
export async function cachedFetch({
  userId,
  cacheName,
  cacheId,
  request,
  maxAgeMs = MAX_AGE_MS,
}) {
  const cacheable = Boolean(cacheName && ALLOWED.has(cacheName));

  try {
    const data = await request();
    if (cacheable) {
      // Not awaited: the caller should not wait on a disk write to render, and
      // writeCache already swallows its own failures.
      writeCache(userId, cacheName, cacheId, data);
    }
    return data;
  } catch (error) {
    if (!cacheable) throw error;
    const entry = await readCache(userId, cacheName, cacheId, { maxAgeMs });
    if (!entry) throw error;
    return {
      ...entry.data,
      __stale: true,
      __savedAt: entry.savedAt,
    };
  }
}

/**
 * True when a value came from the cache rather than the network.
 *
 * Spreading `__stale` across a list response means callers get one field on the
 * envelope; this keeps the check in one place so no screen invents its own.
 */
export const isStale = (result) => Boolean(result && result.__stale);

/** The write time of a possibly-stale result, or null if it was live. */
export const savedAtOf = (result) => (isStale(result) ? result.__savedAt : null);

/** Strip the cache markers before handing an object to rendering logic. */
export function withoutCacheMarkers(result) {
  if (!result || typeof result !== 'object') return result;
  const { __stale, __savedAt, ...rest } = result;
  return rest;
}

/**
 * How much is cached, for the Settings screen.
 *
 * The user is told their itinerary is available offline; they should be able to
 * see whether that claim currently has anything behind it. Returns null rather
 * than zeros when nothing is stored, so the screen can say "empty" instead of
 * "0 saved, never".
 */
export async function cacheSummary(userId) {
  if (!userId) return null;
  try {
    const prefix = `${PREFIX}.${userId}.`;
    const keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(prefix));
    if (!keys.length) return null;

    // readCacheIgnoringAge for the timestamps: an entry past its expiry is not
    // useful, but it is still on disk and still taking space, so it should be
    // counted rather than hidden.
    const stamps = [];
    for (const key of keys) {
      try {
        const raw = await AsyncStorage.getItem(key);
        const parsed = raw ? JSON.parse(raw) : null;
        if (typeof parsed?.savedAt === 'number') stamps.push(parsed.savedAt);
      } catch {
        // A single unreadable entry must not fail the whole summary.
      }
    }
    if (!stamps.length) return null;
    return { count: keys.length, oldest: Math.min(...stamps), newest: Math.max(...stamps) };
  } catch {
    return null;
  }
}

/**
 * Drop every cached entry for a user. Called on sign-out.
 *
 * Uses `multiRemove` on a key scan rather than `clearAll`, because clearing
 * everything would also wipe the saved API base URL - which is a device setting,
 * not user data, and which the next person to sign in should inherit.
 */
export async function clearUserCache(userId) {
  try {
    const prefix = `${PREFIX}.${userId || 'anon'}.`;
    const keys = await AsyncStorage.getAllKeys();
    const mine = keys.filter((k) => k.startsWith(prefix));
    if (mine.length) await AsyncStorage.multiRemove(mine);
    return mine.length;
  } catch {
    return 0;
  }
}

export const cacheKeys = { trips: 'trips', trip: 'trip', itinerary: 'itinerary' };
export const MAX_AGE = MAX_AGE_MS;

export default {
  readCache,
  readCacheIgnoringAge,
  writeCache,
  removeCache,
  cachedFetch,
  clearUserCache,
  cacheSummary,
  isStale,
  savedAtOf,
  withoutCacheMarkers,
  cacheKeys,
  MAX_AGE,
};
