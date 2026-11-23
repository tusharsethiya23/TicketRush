import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, onSessionExpired, refreshSession, setAccessToken } from '../api/client.js';

const AuthContext = createContext(null);

/**
 * FR-20: on load, the refresh cookie silently restores the session. The access token
 * stays in the API client's memory; this context only holds who is signed in.
 */
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    refreshSession().then((u) => {
      if (!alive) return;
      setUser(u);
      setReady(true);
    });
    const stop = onSessionExpired(() => setUser(null));
    return () => {
      alive = false;
      stop();
    };
  }, []);

  const login = useCallback(async (email, password) => {
    const { user: u, accessToken } = await api('/auth/login', { method: 'POST', body: { email, password }, auth: false });
    setAccessToken(accessToken);
    setUser(u);
    return u;
  }, []);

  const register = useCallback(
    async (email, password, role) => {
      await api('/auth/register', { method: 'POST', body: { email, password, role }, auth: false });
      return login(email, password);
    },
    [login],
  );

  const logout = useCallback(async () => {
    try {
      await api('/auth/logout', { method: 'POST', auth: false });
    } finally {
      setAccessToken(null);
      setUser(null);
    }
  }, []);

  const value = useMemo(() => ({ user, ready, login, register, logout }), [user, ready, login, register, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

/** Where each role lands after login. */
export const homeFor = (user) =>
  user?.role === 'organiser' ? '/organiser/events' : user?.role === 'admin' ? '/admin' : '/';
