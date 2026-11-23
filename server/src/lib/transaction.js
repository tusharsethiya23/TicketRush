const mongoose = require('mongoose');

/** Thrown when a transaction still hits write conflicts after every retry (NFR-13). */
class TransactionConflictError extends Error {
  constructor(cause) {
    super('Transaction aborted after repeated write conflicts', { cause });
    this.name = 'TransactionConflictError';
  }
}

const hasLabel = (err, label) => typeof err?.hasErrorLabel === 'function' && err.hasErrorLabel(label);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function commitWithRetry(session) {
  for (let attempt = 0; ; attempt++) {
    try {
      await session.commitTransaction();
      return;
    } catch (err) {
      // The commit may have applied; committing again is safe and tells us for sure.
      if (hasLabel(err, 'UnknownTransactionCommitResult') && attempt < 3) continue;
      throw err;
    }
  }
}

/**
 * Runs `work(session)` in a MongoDB transaction (NFR-2).
 *
 * Unlike the driver's withTransaction(), which keeps retrying for up to 120 s, this
 * retries a write conflict at most `maxRetries` times with jittered backoff, then
 * throws TransactionConflictError so the caller can answer 409 at once (NFR-13).
 * Any other error, including an AppError thrown by `work`, aborts and is rethrown.
 */
async function runTransaction(work, { maxRetries = 3 } = {}) {
  const session = await mongoose.startSession();
  try {
    for (let attempt = 0; ; attempt++) {
      session.startTransaction({ readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
      try {
        const result = await work(session);
        await commitWithRetry(session);
        return result;
      } catch (err) {
        if (session.inTransaction()) await session.abortTransaction().catch(() => {});
        if (!hasLabel(err, 'TransientTransactionError')) throw err;
        if (attempt >= maxRetries) throw new TransactionConflictError(err);
        await sleep(5 * 2 ** attempt + Math.random() * 10);
      }
    }
  } finally {
    await session.endSession();
  }
}

module.exports = { runTransaction, TransactionConflictError };
