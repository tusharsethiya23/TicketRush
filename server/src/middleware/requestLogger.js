const { randomUUID } = require('node:crypto');
const pinoHttp = require('pino-http');
const logger = require('../lib/logger');

// Accept a caller's request ID only if it is short and safe to echo back and log.
const SAFE_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** Structured request logging with a request ID on every line (NFR-9). */
module.exports = pinoHttp({
  logger,
  genReqId(req, res) {
    const incoming = req.headers['x-request-id'];
    const id = typeof incoming === 'string' && SAFE_ID.test(incoming) ? incoming : randomUUID();
    res.setHeader('X-Request-Id', id);
    return id;
  },
  customLogLevel(req, res, err) {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
});
