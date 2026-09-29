// An error that is safe to show to API clients. Anything that is not an
// ApiError is treated as an internal failure and reported as a generic 500.
// `extra` fields are added to the error object of the response, e.g.
// { from, to } for an invalid state transition.
export class ApiError extends Error {
  constructor(statusCode, message, details, extra) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.details = details;
    this.extra = extra;
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
