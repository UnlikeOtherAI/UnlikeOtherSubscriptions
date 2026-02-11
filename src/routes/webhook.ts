import { FastifyInstance } from "fastify";
import {
  WebhookService,
  WebhookSignatureError,
} from "../services/webhook.service.js";

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  const webhookService = new WebhookService();

  // Register raw body parser for the webhook route.
  // Stripe signature verification requires the raw (unparsed) request body.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (_request, body, done) => {
      done(null, body);
    },
  );

  app.post("/v1/stripe/webhook", async (request, reply) => {
    const requestId = request.requestId ?? "unknown";

    // 1. Extract Stripe signature header
    const signature = request.headers["stripe-signature"];
    if (!signature || typeof signature !== "string") {
      return reply.status(400).send({
        error: "Bad Request",
        message: "Missing stripe-signature header",
        statusCode: 400,
        requestId,
      });
    }

    // 2. Verify webhook signature using raw body
    const rawBody = request.body as Buffer;
    let event;
    try {
      event = webhookService.verifySignature(rawBody, signature);
    } catch (err) {
      if (err instanceof WebhookSignatureError) {
        request.log.warn(
          { err, requestId },
          "Stripe webhook signature verification failed",
        );
        return reply.status(400).send({
          error: "Bad Request",
          message: "Invalid webhook signature",
          statusCode: 400,
          requestId,
        });
      }
      throw err;
    }

    // 3. Deduplication: check if this event.id has already been processed
    const isDuplicate = await webhookService.checkAndRecordEvent(
      event.id,
      event.type,
    );
    if (isDuplicate) {
      request.log.info(
        { eventId: event.id, eventType: event.type, requestId },
        "Duplicate Stripe webhook event, skipping",
      );
      return reply.status(200).send({ received: true });
    }

    // 4. Route the event to domain handlers
    const handled = await webhookService.routeEvent(event);

    request.log.info(
      { eventId: event.id, eventType: event.type, handled, requestId },
      "Stripe webhook event processed",
    );

    return reply.status(200).send({ received: true });
  });
}
