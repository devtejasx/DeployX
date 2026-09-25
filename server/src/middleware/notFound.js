import { ApiError } from '../utils/ApiError.js';

// Catches any request that did not match a route and forwards a 404 error.
export function notFound(req, res, next) {
  next(ApiError.notFound(`Route not found: ${req.method} ${req.originalUrl}`));
}
