/**
 * HTTP client for the TripMind mobile API.
 *
 * Three things this does that a bare `fetch` would not:
 *
 * 1. It attaches the bearer token and refreshes it once on a 401, so an
 *    expired session does not bounce the user to the sign-in screen while they
 *    are reading a plan. If the refresh also fails, the token is cleared and the
 *    app falls back to signed-out.
 *
 * 2. It turns every failure into an `ApiError` carrying the server's
 *    machine-readable `code`. This matters more than it looks: the server
 *    distinguishes "the AI is down, retry" (503, retryable) from "there is no
 *    inventory on this corridor" (200, not retryable). A client that collapses
 *    both into `catch (e) { showToast(e.message) }` throws away the single most
 *    useful distinction the backend makes.
 *
 * 3. It separates "the request never landed" from "the server said no". A
 *    dropped connection on platform wifi is the normal case here, not an edge
 *    case, and it deserves its own message.
 */
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';

const TOKEN_KEY = 'tripmind.token';
const BASE_KEY = 'tripmind.apiBaseUrl';

const DEFAULT_BASE_URL = 'http://10.68.29.33:5001/api/mobile';

/** Timeouts per verb. Planning is an LLM round trip; everything else is fast. */
const TIMEOUTS = {
  default: 15000,
  generate: 90000,
  clarify: 60000,
};

export class ApiError extends Error {
  constructor(message, { status = 0, code = 'unknown', retryable = false, offline = false, details = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.offline = offline;
    this.details = details;
  }
}

// ---------------------------------------------------------------- base URL
/**
 * Resolve which backend to talk to.
 *
 * A physical handset cannot reach `localhost`, and an Android emulator cannot
 * reach the LAN address either (it is a separate machine on a bridge). So the
 * host differs by where the app is running, and getting it wrong produces a
 * connection error that looks like the server is down.
 *
 * A saved override always wins, so a demo on someone else's Wi-Fi is one tap in
 * Settings rather than a rebuild.
 */
export async function resolveBaseUrl() {
  const saved = await AsyncStorage.getItem(BASE_KEY);
  if (saved) return saved.replace(/\/+$/, '');

  const fromConfig = Constants.expoConfig?.extra?.apiBaseUrl;
  if (fromConfig) return String(fromConfig).replace(/\/+$/, '');

  if (Constants.expoConfig?.hostUri) {
    // Metro is reachable from the device, which proves which subnet the
    // device is on. Take the host and swap the port.
    const host = String(Constants.expoConfig.hostUri).split('://')[1]?.split(':')[0];
    if (host && host !== 'localhost') return `http://${host}:5001/api/mobile`;
  }

  return DEFAULT_BASE_URL;
}

export async function setBaseUrl(url) {
  const clean = String(url || '').trim().replace(/\/+$/, '');
  if (!clean) {
    await AsyncStorage.removeItem(BASE_KEY);
    return resolveBaseUrl();
  }
  await AsyncStorage.setItem(BASE_KEY, clean);
  return clean;
}

// -------------------------------------------------------------------- token
export async function readToken() {
  try {
    return await SecureStore.getItemAsync(TOKEN_KEY);
  } catch {
    // A corrupt or unreadable keystore entry must not brick the app; the user
    // signs in again, which is recoverable.
    return null;
  }
}

async function writeToken(token) {
  try {
    if (token) await SecureStore.setItemAsync(TOKEN_KEY, token);
    else await SecureStore.deleteItemAsync(TOKEN_KEY);
  } catch {
    // Fall back to AsyncStorage so a keystore failure degrades to slightly
    // less secure rather than to a broken session.
    if (token) await AsyncStorage.setItem(TOKEN_KEY, token);
    else await AsyncStorage.removeItem(TOKEN_KEY);
  }
}

// ------------------------------------------------------------------- client
let cachedBaseUrl = null;
let onUnauthorized = null;
let refreshInFlight = null;

export function setUnauthorizedHandler(handler) {
  onUnauthorized = handler;
}

async function baseUrl() {
  if (!cachedBaseUrl) cachedBaseUrl = await resolveBaseUrl();
  return cachedBaseUrl;
}

/** Drop the memoised base URL, e.g. after the user edits it in Settings. */
export function invalidateBaseUrl() {
  cachedBaseUrl = null;
}

function withTimeout(ms) {
  let timer;
  const controller = new AbortController();
  const signal = controller.signal;
  const promise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ApiError('The server took too long to respond.', {
        code: 'timeout',
        retryable: true,
      }));
    }, ms);
  });
  return { signal, promise, clear: () => clearTimeout(timer), controller };
}

async function send(method, path, { body, token, timeout, retryOn401 = true } = {}) {
  const url = `${await baseUrl()}${path}`;
  const { signal, promise, clear, controller } = withTimeout(timeout ?? TIMEOUTS.default);

  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  let response;
  try {
    response = await Promise.race([
      fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      }),
      promise,
    ]);
  } catch (error) {
    clear();
    if (error instanceof ApiError) throw error;
    if (error?.name === 'AbortError') {
      throw new ApiError('The server took too long to respond.', {
        code: 'timeout',
        retryable: true,
      });
    }
    // fetch only rejects for a transport-level failure, so this is the device
    // being offline, the API being down, or the base URL being wrong. All three
    // are worth retrying, and all three are worth naming.
    throw new ApiError(
      'Cannot reach the TripMind server. Check your connection and the API address in Settings.',
      { code: 'network_unreachable', retryable: true, offline: true },
    );
  }
  clear();

  // 204 and empty bodies are legitimate; do not force a JSON parse.
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      // A proxy or captive portal answering with HTML is common on travel wifi.
      throw new ApiError(
        'The server sent an unexpected response. You may be behind a captive portal.',
        { code: 'bad_response', status: response.status, retryable: true },
      );
    }
  }

  if (response.ok) return payload ?? {};

  // One transparent retry on an expired token, guarded so two concurrent 401s
  // cannot both trigger a refresh.
  if (response.status === 401 && retryOn401 && token) {
    const refreshed = await refreshSession();
    if (refreshed) {
      return send(method, path, {
        body,
        token: refreshed,
        timeout,
        retryOn401: false,
      });
    }
  }

  throw new ApiError(
    payload?.error || `Request failed (${response.status}).`,
    {
      status: response.status,
      code: payload?.code || `http_${response.status}`,
      // A 503 from the planner is the server telling us to try again; a 400 is
      // the server telling us the request was wrong. Never retry the latter.
      retryable: payload?.retryable === true || response.status >= 500,
      details: payload?.details || null,
    },
  );
}

export const api = {
  get: (path, opts) => send('GET', path, opts),
  post: (path, body, opts) => send('POST', path, { ...opts, body: body ?? {} }),
  patch: (path, body, opts) => send('PATCH', path, { ...opts, body: body ?? {} }),
  del: (path, opts) => send('DELETE', path, opts),

  health: () => send('GET', '/health'),
  generate: (path, opts) => send('POST', path, { ...opts, timeout: TIMEOUTS.generate }),
  clarify: (path, opts) => send('POST', path, { ...opts, timeout: TIMEOUTS.clarify }),

  // ------------------------------------------------------------- session
  async signIn(email, password) {
    const result = await send('POST', '/auth/login', {
      body: { email, password, remember: true },
    });
    if (result?.token) await writeToken(result.token);
    return result;
  },

  async register(payload) {
    return send('POST', '/auth/register', { body: payload });
  },

  async me(token) {
    return send('GET', '/auth/me', { token });
  },

  async signOut() {
    await writeToken(null);
  },
};

/**
 * Re-establish the session from a stored token.
 *
 * Runs at most once at a time. `Promise` deduplication rather than a boolean
 * flag, because a flag would let the second caller proceed before the first
 * refresh finished and send a stale token.
 */
async function refreshSession() {
  const token = await readToken();
  if (!token) return null;
  if (!refreshInFlight) {
    refreshInFlight = api
      .me(token)
      .then(() => token)
      .catch(() => {
        writeToken(null);
        onUnauthorized?.();
        return null;
      })
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}
