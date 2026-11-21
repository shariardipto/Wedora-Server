import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { ApiError } from "../lib/api-error.js";

/** Every failure uses the same envelope: { success: false, message, error: { code } }. */
function sendError(
  response: Parameters<RequestHandler>[1],
  status: number,
  code: string,
  message: string,
  details?: unknown,
) {
  response.status(status).json({
    success: false,
    message,
    error: details === undefined ? { code } : { code, details },
  });
}

export const notFoundHandler: RequestHandler = (_request, response) => {
  sendError(response, 404, "ROUTE_NOT_FOUND", "This API route does not exist.");
};

/** Body-parser errors carry a `type` string such as "entity.parse.failed". */
function bodyParserType(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "type" in error) {
    return typeof error.type === "string" ? error.type : undefined;
  }
  return undefined;
}

/** MongoDB duplicate-key (11000) and document-validation (121) failures. */
function isMongoConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "MongoServerError" &&
    [11000, 121].includes((error as { code?: unknown }).code as number)
  );
}

export const errorHandler: ErrorRequestHandler = (
  error: unknown,
  _request,
  response,
  next,
) => {
  if (response.headersSent) {
    next(error);
    return;
  }

  if (error instanceof ApiError) {
    if (error.status === 401) response.set("WWW-Authenticate", "Bearer");
    sendError(response, error.status, error.code, error.message);
    return;
  }

  if (error instanceof ZodError) {
    sendError(
      response,
      400,
      "VALIDATION_ERROR",
      "Please check the highlighted fields.",
      error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      })),
    );
    return;
  }

  if (isMongoConflict(error)) {
    sendError(
      response,
      409,
      "RECORD_CONFLICT",
      "This request conflicts with an existing record.",
    );
    return;
  }

  const parserType = bodyParserType(error);
  if (parserType === "entity.parse.failed") {
    sendError(
      response,
      400,
      "INVALID_JSON",
      "Request body must contain valid JSON.",
    );
    return;
  }
  if (parserType === "entity.too.large") {
    sendError(response, 413, "PAYLOAD_TOO_LARGE", "Request body is too large.");
    return;
  }

  // Unexpected: log for the operator, never leak internals to the client.
  console.error("Unhandled API error:", error);
  sendError(
    response,
    500,
    "INTERNAL_ERROR",
    "Something went wrong on our side. Please try again.",
  );
};
