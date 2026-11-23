import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';
import Notice from './Notice.jsx';

/** Waits for the silent refresh, then sends guests to login and the wrong role away. */
export default function RequireAuth({ roles, children }) {
  const { user, ready } = useAuth();
  const location = useLocation();

  if (!ready) return <p className="muted">Loading…</p>;
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />;
  if (roles && !roles.includes(user.role)) {
    return <Notice kind="error">This page is for {roles.join(' or ')} accounts.</Notice>;
  }
  return children;
}
