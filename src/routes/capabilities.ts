import { FastifyInstance } from "fastify";
import { getAllSchemas } from "../services/usage-event-schema-registry.js";
import { MAX_BATCH_SIZE } from "../services/usage-event.service.js";

export async function capabilitiesRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/meta/capabilities", async (_request, reply) => {
    const schemas = getAllSchemas();

    const eventTypes = schemas.map((s) => ({
      eventType: s.eventType,
      version: s.version,
      status: s.status,
    }));

    const meters = [
      ...new Set(
        schemas.map((s) => {
          // Derive meter name from eventType by dropping version suffix
          const parts = s.eventType.split(".");
          parts.pop(); // remove version e.g. "v1"
          return parts.join(".");
        }),
      ),
    ];

    return reply.status(200).send({
      usageIngestion: {
        maxBatchSize: MAX_BATCH_SIZE,
        supportedEventTypes: eventTypes,
      },
      meters,
      apiVersion: "v1",
    });
  });
}
