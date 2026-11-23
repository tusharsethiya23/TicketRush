import { errorMessage } from '../api/errors.js';

const ICONS = { error: '!', success: '✓', info: 'i', warning: '!' };

/**
 * A message box. Errors are announced to screen readers at once (role="alert");
 * other kinds politely. Kind is shown by an icon and text, not colour alone.
 */
export default function Notice({ kind = 'info', error, children, action }) {
  const text = error ? errorMessage(error) : children;
  if (!text) return null;
  return (
    <div className={`notice notice-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <span className="notice-icon" aria-hidden="true">
        {ICONS[kind]}
      </span>
      <div className="notice-body">
        {text}
        {error?.requestId && <span className="notice-ref"> Reference: {error.requestId}</span>}
      </div>
      {action}
    </div>
  );
}
