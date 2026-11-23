/**
 * FR-23: one checkout per hold, kept in sessionStorage so a page reload keeps the same
 * Idempotency-Key. Every Pay retry for that hold reuses the key, so a payment can never
 * be taken twice, even if a response is lost on the way back.
 */
const keyFor = (holdId) => `tr.checkout.${holdId}`;

export function saveCheckout({ hold, event, seats }) {
  const checkout = { hold, event, seats, idempotencyKey: crypto.randomUUID() };
  sessionStorage.setItem(keyFor(hold.id), JSON.stringify(checkout));
  return checkout;
}

export function loadCheckout(holdId) {
  try {
    return JSON.parse(sessionStorage.getItem(keyFor(holdId)));
  } catch {
    return null;
  }
}

export function clearCheckout(holdId) {
  sessionStorage.removeItem(keyFor(holdId));
}
