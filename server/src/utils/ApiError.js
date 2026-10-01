// An error that is safe to show to API clients. Anything that is not an
// ApiError is treated as an internal failure and reported as a generic 500.
// `extra` fields are added to the error object of the response, e.g.
// { from, to } for an invalid state transition. `code` is a stable,
// machine-readable name; by default it follows from the status code.
export class ApiError extends Error {
  constructor(statusCode, message, details, extra, code) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.details = details;
    this.extra = extra;
    this.code = code ?? defaultErrorCode(statusCode, details);
  }

  static badRequest(message, details) {
    return new ApiError(400, message, details);
  }

  static notFound(message) {
    return new ApiError(404, message);
  }

  static conflict(message) {
    return new ApiError(409, message);
  }
}

const CODES = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  429: 'RATE_LIMITED',
  500: 'INTERNAL_ERROR',
  503: 'SERVICE_UNAVAILABLE',
};

export function defaultErrorCode(statusCode, details) {
  if (statusCode === 400 && details) return 'VALIDATION_FAILED';
  return CODES[statusCode] ?? (statusCode >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST');
}
