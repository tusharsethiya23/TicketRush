const { ZodError } = require('zod');
const AppError = require('../lib/AppError');

function notFound(req, res, next) {
  next(new AppError(404, 'NOT_FOUND', `Route ${req.method} ${req.path} not found`));
}

/** Turns every error into the single error shape from SRS 8.2. */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  let status = 500;
  let code = 'INTERNAL';
  let message = 'Something went wrong';
  let details;

  if (err instanceof AppError) {
    ({ status, code, message, details } = err);
  } else if (err instanceof ZodError) {
    status = 400;
    code = 'VALIDATION_FAILED';
    message = 'Request is invalid';
    details = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
  } else if (err.type === 'entity.parse.failed') {
    status = 400;
    code = 'VALIDATION_FAILED';
    message = 'Malformed JSON body';
  } else if (err.type === 'entity.too.large') {
    status = 413;
    code = 'PAYLOAD_TOO_LARGE';
    message = 'Request body is too large';
  } else if (err.code === 11000) {
    status = 409;
    code = 'CONFLICT';
    message = 'Resource already exists';
  }

  if (status >= 500 && req.log) {
    req.log.error({ err }, 'Unhandled error');
  }

  if (res.headersSent) return;

  res.status(status).json({
    error: { code, message, requestId: req.id, ...(details && { details }) },
  });
}

module.exports = { notFound, errorHandler };
