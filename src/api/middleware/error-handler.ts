import type { FastifyError, FastifyRequest, FastifyReply } from "fastify";
import { logger } from "../../logger/index.js";

export function globalErrorHandler(
  error: FastifyError,
  _request: FastifyRequest,
  reply: FastifyReply,
) {
  const statusCode = error.statusCode ?? 500;
  const message = statusCode >= 500 ? "Internal server error" : error.message;

  if (statusCode >= 500) {
    logger.error({ err: error, statusCode }, "Unhandled server error");
  } else {
    logger.warn({ err: error, statusCode }, "Client error");
  }

  reply.code(statusCode).send({
    error: message,
    code: error.code ?? "UNKNOWN",
    ...(process.env.NODE_ENV === "development" && { stack: error.stack }),
  });
}
