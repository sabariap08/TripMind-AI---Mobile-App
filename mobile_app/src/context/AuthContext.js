/**
 * Session state for the whole app.
 *
 * One rule worth stating: an expired token signs the user out silently rather
 * than throwing them back to a sign-in screen with a form to refill. The token
 * lives in the device keystore, so re-authentication is one tap and the app
 * returns to wherever they were.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { auth as authApi } from '../api/endpoints';
import { readToken, setUnauthorizedHandler } from '../api/client';
import { clearUserCache } from '../utils/cache';

const AuthContext = createContext(null);

/**
 * The stable identity used to namespace the offline cache.
 *
 * `id` is preferred because an email can be changed; the email is a fallback for
 * a user object that somehow lacks one. Returns null when signed out, which makes
 * the cache keys unguessable-by-accident rather than shared across accounts.
 */
const cacheScopeOf = (user) => (user ? String(user.id || user.email || '') : null);

export function AuthProvider({ children }) {
  const [token, setToken] = useState(null);
  const [user, setUser] = useState(null);
  const [restoring, setRestoring] = useState(true);

  // Guards against setting state after unmount during the restore request,
  // which on a slow connection produces a React warning and a stuck spinner.
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const signOutLocally = useCallback(async () => {
    // Cached trips are the previous traveller's itinerary and their wallet
    // balance. On a shared handset the next sign-in must not be able to read
    // them, so the cache is scoped by user id and dropped here. This is also
    // the one place the app knows a session is really over rather than merely
    // failing to refresh, so it is the right hook.
    const scope = cacheScopeOf(user);
    await authApi.signOut();
    if (scope) await clearUserCache(scope);
    setToken(null);
    setUser(null);
  }, [user]);

  // The API client calls this when a refresh fails, so the whole app agrees the
  // session is over without the client reaching into context directly.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setToken(null);
      setUser(null);
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  // Restore a saved session on cold start. A token that no longer resolves
  // (account deleted, suspended) is discarded rather than left to fail the
  // first screen that uses it.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const stored = await readToken();
      if (!stored) {
        if (!cancelled) setRestoring(false);
        return;
      }
      try {
        const result = await authApi.me(stored);
        if (cancelled) return;
        if (result?.user) {
          setToken(stored);
          setUser(result.user);
        } else {
          await authApi.signOut();
        }
      } catch {
        if (!cancelled) await authApi.signOut();
      } finally {
        if (!cancelled) setRestoring(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const signIn = useCallback(async (email, password) => {
    const result = await authApi.signIn(email, password);
    setToken(result.token);
    setUser(result.user);
    return result;
  }, []);

  const register = useCallback(async (payload) => authApi.register(payload), []);

  const value = useMemo(
    () => ({
      token,
      user,
      restoring,
      isSignedIn: !!token && !!user,
      // Namespaces the offline cache. Screens pass this to `cachedFetch` rather
      // than reaching for the user object, so they never have to think about
      // which field is the stable identifier.
      cacheScope: cacheScopeOf(user),
      signIn,
      register,
      signOut: signOutLocally,
      setUser,
    }),
    [token, user, restoring, signIn, register, signOutLocally],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside an AuthProvider');
  return context;
}

export default AuthContext;
