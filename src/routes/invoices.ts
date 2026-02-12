import { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  InvoiceService,
  InvoiceNotFoundError,
  InvalidInvoiceStatusError,
  TeamNotFoundError,
  BillingEntityNotFoundError,
} from "../services/invoice.service.js";

const invoiceIdParamSchema = z.object({
  id: z.string().uuid(),
});

const generateBodySchema = z.object({
  teamId: z.string().uuid(),
  periodStart: z.string().datetime(),
  periodEnd: z.string().datetime(),
});

export async function invoiceRoutes(app: FastifyInstance): Promise<void> {
  const invoiceService = new InvoiceService();

  app.post("/v1/invoices/generate", async (request, reply) => {
    const body = generateBodySchema.parse(request.body);

    try {
      const result = await invoiceService.generate({
        teamId: body.teamId,
        periodStart: body.periodStart,
        periodEnd: body.periodEnd,
      });

      request.log.info(
        { invoiceId: result.id, teamId: body.teamId },
        "Invoice generated",
      );

      return reply.status(201).send(result);
    } catch (err) {
      if (err instanceof TeamNotFoundError) {
        return reply.status(404).send({
          error: "Not Found",
          message: err.message,
          statusCode: 404,
          requestId: request.requestId,
        });
      }
      if (err instanceof BillingEntityNotFoundError) {
        return reply.status(404).send({
          error: "Not Found",
          message: err.message,
          statusCode: 404,
          requestId: request.requestId,
        });
      }
      throw err;
    }
  });

  app.get("/v1/invoices/:id", async (request, reply) => {
    const params = invoiceIdParamSchema.parse(request.params);

    try {
      const invoice = await invoiceService.getById(params.id);

      return reply.status(200).send(invoice);
    } catch (err) {
      if (err instanceof InvoiceNotFoundError) {
        return reply.status(404).send({
          error: "Not Found",
          message: err.message,
          statusCode: 404,
          requestId: request.requestId,
        });
      }
      throw err;
    }
  });

  app.post("/v1/invoices/:id/export", async (request, reply) => {
    const params = invoiceIdParamSchema.parse(request.params);

    try {
      const exported = await invoiceService.export(params.id);

      return reply.status(200).send(exported);
    } catch (err) {
      if (err instanceof InvoiceNotFoundError) {
        return reply.status(404).send({
          error: "Not Found",
          message: err.message,
          statusCode: 404,
          requestId: request.requestId,
        });
      }
      throw err;
    }
  });

  app.post("/v1/invoices/:id/mark-paid", async (request, reply) => {
    const params = invoiceIdParamSchema.parse(request.params);

    try {
      const result = await invoiceService.markPaid(params.id);

      request.log.info(
        { invoiceId: params.id, status: result.status },
        "Invoice marked as paid",
      );

      return reply.status(200).send(result);
    } catch (err) {
      if (err instanceof InvoiceNotFoundError) {
        return reply.status(404).send({
          error: "Not Found",
          message: err.message,
          statusCode: 404,
          requestId: request.requestId,
        });
      }
      if (err instanceof InvalidInvoiceStatusError) {
        return reply.status(400).send({
          error: "Bad Request",
          message: err.message,
          statusCode: 400,
          requestId: request.requestId,
        });
      }
      throw err;
    }
  });
}
