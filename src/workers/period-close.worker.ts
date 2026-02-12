import PgBoss from "pg-boss";
import { getBoss } from "../lib/pg-boss.js";
import { PeriodCloseService } from "../services/period-close.service.js";

export const PERIOD_CLOSE_QUEUE = "period-close";
const DEFAULT_POLL_INTERVAL_SECONDS = 60;

export interface PeriodCloseWorkerOptions {
  pollingIntervalSeconds?: number;
}

export class PeriodCloseWorker {
  private periodCloseService: PeriodCloseService;
  private pollingIntervalSeconds: number;

  constructor(
    periodCloseService?: PeriodCloseService,
    options: PeriodCloseWorkerOptions = {},
  ) {
    this.periodCloseService = periodCloseService ?? new PeriodCloseService();
    this.pollingIntervalSeconds =
      options.pollingIntervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS;
  }

  async start(boss?: PgBoss): Promise<void> {
    const pgBoss = boss ?? getBoss();
    if (!pgBoss) {
      throw new Error("pg-boss is not initialized");
    }

    await pgBoss.createQueue(PERIOD_CLOSE_QUEUE);

    await pgBoss.work<Record<string, never>>(
      PERIOD_CLOSE_QUEUE,
      { pollingIntervalSeconds: this.pollingIntervalSeconds },
      async () => {
        await this.processPeriodClose();
      },
    );

    // Run daily at 1 AM UTC to close billing periods
    await pgBoss.schedule(PERIOD_CLOSE_QUEUE, `0 1 * * *`);
  }

  async processPeriodClose() {
    const result = await this.periodCloseService.runPeriodClose();

    if (result.processed > 0 || result.failed > 0) {
      console.log(
        `[period-close-worker] Run complete: ${result.processed} processed, ` +
          `${result.skipped} skipped, ${result.failed} failed, ` +
          `${result.invoices.length} invoices generated`,
      );
    }

    return result;
  }
}
