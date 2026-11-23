/**
 * Plain-language messages for the API's error codes (NFR-12). Each says what happened
 * and what the person can do next.
 */
const MESSAGES = {
  NETWORK: 'Cannot reach TicketRush. Check your connection and try again.',
  SEAT_TAKEN: 'Someone else just took one of those seats. The map is updated, so please pick again.',
  HOLD_EXPIRED: 'Your hold ran out, so the seats went back on sale.',
  PAYMENT_FAILED: 'Your payment was declined. You can try again; you will never be charged twice.',
  REQUEST_IN_PROGRESS: 'Your payment is still being processed. Wait a moment, then try again.',
  TOO_MANY_HOLDS: 'You already have 2 seat holds for this event. Pay for or release one first.',
  SALE_NOT_STARTED: 'Tickets for this event are not on sale right now.',
  CANCEL_WINDOW_CLOSED: 'Bookings can only be cancelled up to 24 hours before the event.',
  INVALID_CREDENTIALS: 'That email and password do not match an account.',
  EMAIL_TAKEN: 'An account with that email already exists. Try logging in.',
  EVENT_NOT_EDITABLE: 'This event is already published, so it can no longer be edited.',
  FORBIDDEN: 'You do not have access to this.',
  NOT_FOUND: 'We could not find that. It may have been removed.',
  CONFLICT: 'Lots of people are doing this right now. Please try again.',
  IDEMPOTENCY_KEY_REUSED: 'This checkout got mixed up with another one. Start again from the event page.',
  PAYLOAD_TOO_LARGE: 'That is too much data to send at once.',
  UNAUTHENTICATED: 'Please log in to continue.',
};

export function errorMessage(err) {
  if (!err) return '';
  if (err.code === 'RATE_LIMITED') {
    return err.retryAfter
      ? `Too many requests. Please wait ${err.retryAfter} s and try again.`
      : 'Too many requests. Please wait a moment and try again.';
  }
  if (err.code === 'VALIDATION_FAILED' && err.details?.length) {
    return err.details.map((d) => (d.path ? `${d.path}: ${d.message}` : d.message)).join(' · ');
  }
  return MESSAGES[err.code] ?? err.message ?? 'Something went wrong. Please try again.';
}
