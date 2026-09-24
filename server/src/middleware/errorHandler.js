import config from '../config/index.js';

// Global error handler. Express recognises it by its four-argument signature,
// so `next` must stay in the parameter list even though it is unused.
export function errorHandler(err, req, res, next) {
  // Malformed JSON bodies surface as body-parser errors with a status attached.
  const statusCode = err.statusCode || err.status || 500;

  if (statusCode >= 500) {
    console.error(`[api] ${req.method} ${req.originalUrl} failed:`, err);
  }

  const body = {
    error: {
      message: statusCode >= 500 ? 'Internal server error' : err.message,
      statusCode,
    },
  };

  if (config.env === 'development' && statusCode >= 500) {
    body.error.details = err.message;
  }

  res.status(statusCode).json(body);
}
