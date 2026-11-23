const { runTransaction, TransactionConflictError } = require('../src/lib/transaction');
const { Seat } = require('../src/models');
const { connectTestDb, closeTestDb } = require('./helpers/db');
const { Types } = require('mongoose');

beforeAll(connectTestDb);
afterAll(closeTestDb);

/** An error shaped like the driver's write conflict. */
function writeConflict() {
  const err = new Error('WriteConflict');
  err.hasErrorLabel = (label) => label === 'TransientTransactionError';
  return err;
}

describe('runTransaction (NFR-13)', () => {
  test('retries a write conflict and succeeds', async () => {
    let calls = 0;
    const result = await runTransaction(async () => {
      calls += 1;
      if (calls < 3) throw writeConflict();
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  test('gives up after 3 retries with TransactionConflictError', async () => {
    let calls = 0;
    const attempt = runTransaction(async () => {
      calls += 1;
      throw writeConflict();
    });
    await expect(attempt).rejects.toBeInstanceOf(TransactionConflictError);
    expect(calls).toBe(4); // 1 try + 3 retries
  });

  test('does not retry other errors, and rolls back their writes', async () => {
    const eventId = new Types.ObjectId();
    let calls = 0;
    const attempt = runTransaction(async (session) => {
      calls += 1;
      await Seat.create([{ eventId, section: 'A', row: '1', number: 1, pricePaise: 1 }], { session });
      throw new Error('business rule failed');
    });
    await expect(attempt).rejects.toThrow('business rule failed');
    expect(calls).toBe(1);
    expect(await Seat.countDocuments({ eventId })).toBe(0);
  });
});
