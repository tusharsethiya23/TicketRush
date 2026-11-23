import { useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { homeFor, useAuth } from '../auth/AuthContext.jsx';
import Notice from '../components/Notice.jsx';

/** Only same-site paths, so ?next= cannot send someone to another website. */
const safeNext = (next) => (next && next.startsWith('/') && !next.startsWith('//') ? next : null);

function AuthForm({ mode }) {
  const { user, ready, login, register } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [form, setForm] = useState({ email: '', password: '', role: 'user' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const isRegister = mode === 'register';

  if (ready && user) return <Navigate to={safeNext(params.get('next')) ?? homeFor(user)} replace />;

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const u = isRegister ? await register(form.email, form.password, form.role) : await login(form.email, form.password);
      navigate(safeNext(params.get('next')) ?? homeFor(u), { replace: true });
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  const set = (field) => (e) => setForm({ ...form, [field]: e.target.value });

  return (
    <div className="auth">
      <form className="card auth-card" onSubmit={submit}>
        <h1>{isRegister ? 'Create your account' : 'Log in'}</h1>
        <Notice kind="error" error={error} />
        <label>
          Email
          <input type="email" autoComplete="email" required value={form.email} onChange={set('email')} />
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete={isRegister ? 'new-password' : 'current-password'}
            required
            minLength={isRegister ? 8 : undefined}
            value={form.password}
            onChange={set('password')}
            aria-describedby={isRegister ? 'password-hint' : undefined}
          />
          {isRegister && (
            <span id="password-hint" className="muted small">
              At least 8 characters.
            </span>
          )}
        </label>
        {isRegister && (
          <fieldset className="radio-group">
            <legend>I want to</legend>
            <label>
              <input type="radio" name="role" value="user" checked={form.role === 'user'} onChange={set('role')} /> Book tickets
            </label>
            <label>
              <input type="radio" name="role" value="organiser" checked={form.role === 'organiser'} onChange={set('role')} /> Sell
              tickets as an organiser
            </label>
          </fieldset>
        )}
        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
          {busy ? 'Please wait…' : isRegister ? 'Sign up' : 'Log in'}
        </button>
        <p className="muted small">
          {isRegister ? (
            <>
              Already have an account? <Link to={`/login${params.toString() ? `?${params}` : ''}`}>Log in</Link>
            </>
          ) : (
            <>
              New here? <Link to={`/register${params.toString() ? `?${params}` : ''}`}>Create an account</Link>
            </>
          )}
        </p>
      </form>
    </div>
  );
}

export const LoginPage = () => <AuthForm mode="login" />;
export const RegisterPage = () => <AuthForm mode="register" />;
