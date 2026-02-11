import { FastifyInstance, FastifyError } from "fastify";
import { ZodError } from "zod";

interface StructuredError {
  error: string;
  message: string;
  statusCode: number;
  requestId?: string;
  issues?: Array<{
    path: (string | number)[];
    message: string;
  }>;
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: Error | FastifyError, request, reply) => {
    const requestId = request.requestId ?? "unknown";

    if (error instanceof ZodError) {
      const body: StructuredError = {
        error: "Validation Error",
        message: "Request validation failed",
        statusCode: 400,
        requestId,
        issues: error.issues.map((issue) => ({
          path: issue.path,
          message: issue.message,
        })),
      };
      request.log.warn({ err: error, requestId }, "Validation error");
      return reply.status(400).send(body);
    }

    // Fastify validation errors (from schema validation)
    if ("validation" in error && error.validation) {
      const body: StructuredError = {
        error: "Validation Error",
        message: error.message,
        statusCode: 400,
        requestId,
      };
      request.log.warn({ err: error, requestId }, "Validation error");
      return reply.status(400).send(body);
    }

    request.log.error({ err: error, requestId }, "Internal server error");

    const body: StructuredError = {
      error: "Internal Server Error",
      message: "An unexpected error occurred",
      statusCode: 500,
      requestId,
    };
    return reply.status(500).send(body);
  });
}
