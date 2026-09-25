// Every successful response has the shape { success: true, data }.
// Errors ({ success: false, error }) are produced by the error handler.
export function sendSuccess(res, data, statusCode = 200) {
  res.status(statusCode).json({ success: true, data });
}
