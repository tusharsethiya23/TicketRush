const { setTimeout: sleep } = require('node:timers/promises');
const config = require('../config/env');

/**
 * Simulated payment gateway (FR-12). It takes PAYMENT_DELAY_MS and succeeds with
 * probability PAYMENT_SUCCESS_RATE. Callers go through this object (payments.charge),
 * so tests can force an outcome with jest.spyOn(payments, 'charge').
 *
 * @returns {Promise<boolean>} true if the charge succeeded
 */
async function charge({ amountPaise }) {
  if (!Number.isInteger(amountPaise) || amountPaise < 0) throw new Error('Invalid payment amount');
  if (config.PAYMENT_DELAY_MS > 0) await sleep(config.PAYMENT_DELAY_MS);
  return Math.random() < config.PAYMENT_SUCCESS_RATE;
}

const payments = { charge };

module.exports = payments;
