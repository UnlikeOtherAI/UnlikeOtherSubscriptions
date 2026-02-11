import { buildServer } from "./lib/server.js";

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const HOST = process.env.HOST ?? "0.0.0.0";

async function main(): Promise<void> {
  const app = buildServer();

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "Received shutdown signal, closing gracefully");
    try {
      await app.close();
      app.log.info("Graceful shutdown complete");
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, "Error during graceful shutdown");
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  try {
    await app.listen({ port: PORT, host: HOST });
  } catch (err) {
    app.log.fatal({ err }, "Failed to start server");
    process.exit(1);
  }
}

main();
