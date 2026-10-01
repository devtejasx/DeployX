import { recordAudit } from '../services/audit.service.js';
import { ApiError, defaultErrorCode } from '../utils/ApiError.js';
import { logger } from '../lib/logger.js';

// PostgreSQL error codes that indicate bad input rather than a server fault.
// Validation should catch these first; this is the safety net.
const PG_ERRORS = {
  23505: { statusCode: 409, message: 'Resource already exists' }, // unique_violation
  23503: { statusCode: 409, message: 'Related resource does not exist' }, // foreign_key_violation
  23514: { statusCode: 400, message: 'Invalid data' }, // check_violation
  '22P02': { statusCode: 400, message: 'Invalid data' }, // invalid_text_representation
  22001: { statusCode: 400, message: 'Invalid data' }, // string_data_right_truncation
};

function toClientError(err) {
  if (err instanceof ApiError) {
    return { statusCode: err.statusCode, code: err.code, message: err.message, details: err.details, extra: err.extra };
  }

  // Raised by the body parsers for unparsable or oversized bodies.
  if (err.type === 'entity.parse.failed') {
    return { statusCode: 400, message: 'Malformed JSON in request body' };
  }
  if (err.type === 'entity.too.large') {
    return { statusCode: 413, message: 'Request body too large' };
  }
  if (err.type === 'encoding.unsupported' || err.type === 'charset.unsupported') {
    return { statusCode: 415, message: 'Unsupported request body encoding' };
  }

  if (err.code && PG_ERRORS[err.code]) {
    return PG_ERRORS[err.code];
  }

  return { statusCode: 500, message: 'Internal server error' };
}

// Global error handler. Express recognises it by its four-argument signature,
// so `next` must stay in the parameter list even though it is unused.
//
// Every error response has the same shape, in development and production:
//   { success: false, error: { code, message, details? } }
// Internal details (SQL, stack traces, connection strings, file paths) are
// only logged, never sent to the client.
export function errorHandler(err, req, res, next) {
  const { statusCode, code, message, details, extra } = toClientError(err);

  // Deliberate ApiErrors (e.g. 503 queue unavailable) are logged where they
  // are raised; only unexpected failures need a stack trace here.
  if (statusCode >= 500 && !(err instanceof ApiError)) {
    logger.error('request_failed', { requestId: req.id, method: req.method, path: req.originalUrl.split('?')[0], err });
  }

  // A signed-in user reaching for something that is not theirs.
  if (statusCode === 403 && req.user) {
    recordAudit({ req, action: 'access.denied', details: { method: req.method, path: req.originalUrl.slice(0, 300), reason: message } });
  }

  if (res.headersSent) {
    res.end();
    return;
  }
  const error = { code: code ?? defaultErrorCode(statusCode, details), message, ...extra };
  if (details) error.details = details;

  res.status(statusCode).json({ success: false, error });
}
