import { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  InvoiceService,
  InvoiceNotFoundError,
  InvalidInvoiceStatusError,
  TeamNotFoundError,
  BillingEntityNotFoundError,
} from "../services/invoice.service.js";
import { AuditLogService } from "../services/audit-log.service.js";

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
  const auditLogService = new AuditLogService();

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

      await auditLogService.log({
        action: "invoice.generate",
        entityType: "Invoice",
        entityId: result.id,
        actor: "admin",
        metadata: {
          teamId: body.teamId,
          periodStart: body.periodStart,
          periodEnd: body.periodEnd,
          requestId: request.requestId,
        },
      });

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

      await auditLogService.log({
        action: "invoice.view",
        entityType: "Invoice",
        entityId: params.id,
        actor: "admin",
        metadata: { requestId: request.requestId },
      });

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

      await auditLogService.log({
        action: "invoice.export",
        entityType: "Invoice",
        entityId: params.id,
        actor: "admin",
        metadata: { requestId: request.requestId },
      });

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

      await auditLogService.log({
        action: "invoice.mark-paid",
        entityType: "Invoice",
        entityId: params.id,
        actor: "admin",
        metadata: {
          status: result.status,
          requestId: request.requestId,
        },
      });

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
