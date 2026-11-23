import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';

const LINKS = {
  guest: [{ to: '/', label: 'Events' }],
  user: [
    { to: '/', label: 'Events' },
    { to: '/bookings', label: 'My bookings' },
  ],
  organiser: [
    { to: '/', label: 'Events' },
    { to: '/organiser/events', label: 'My events' },
  ],
  admin: [
    { to: '/', label: 'Events' },
    { to: '/admin', label: 'Admin' },
  ],
};

export default function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const links = LINKS[user?.role ?? 'guest'];

  async function handleLogout() {
    await logout();
    navigate('/');
  }

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <div className="topbar-inner">
          <Link to="/" className="brand" aria-label="TicketRush home">
            <svg viewBox="0 0 32 32" width="24" height="24" aria-hidden="true">
              <path
                fill="currentColor"
                d="M4 8a2 2 0 0 1 2-2h20a2 2 0 0 1 2 2v4a4 4 0 0 0 0 8v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-4a4 4 0 0 0 0-8z"
              />
            </svg>
            TicketRush
          </Link>
          <nav aria-label="Main" className="nav">
            {links.map((l) => (
              <NavLink key={l.to} to={l.to} end={l.to === '/'}>
                {l.label}
              </NavLink>
            ))}
          </nav>
          <div className="account">
            {user ? (
              <>
                <span className="muted account-email" title={user.email}>
                  {user.email}
                </span>
                <button type="button" className="btn btn-ghost btn-sm" onClick={handleLogout}>
                  Log out
                </button>
              </>
            ) : (
              <>
                <Link to="/login" className="btn btn-ghost btn-sm">
                  Log in
                </Link>
                <Link to="/register" className="btn btn-primary btn-sm">
                  Sign up
                </Link>
              </>
            )}
          </div>
        </div>
      </header>
      <main id="main" className="main">
        <Outlet />
      </main>
    </div>
  );
}
