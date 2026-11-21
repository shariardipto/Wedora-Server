/**
 * An expected failure with a safe, user-facing message.
 * Thrown from routes/services and converted to JSON by the error handler.
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const badRequest = (message: string, code = "BAD_REQUEST") =>
  new ApiError(400, code, message);

export const unauthorized = (
  message = "Please sign in to continue.",
  code = "UNAUTHORIZED",
) => new ApiError(401, code, message);

export const forbidden = (
  message = "You do not have permission to do that.",
  code = "FORBIDDEN",
) => new ApiError(403, code, message);

export const notFound = (message: string, code = "NOT_FOUND") =>
  new ApiError(404, code, message);

export const conflict = (message: string, code = "CONFLICT") =>
  new ApiError(409, code, message);
