import PgBoss from "pg-boss";
import { getBoss } from "../lib/pg-boss.js";
import { WalletDebitService } from "../services/wallet-debit.service.js";

export const WALLET_DEBIT_QUEUE = "wallet-debit-daily";
const DEFAULT_POLL_INTERVAL_SECONDS = 60;

export interface WalletDebitWorkerOptions {
  pollingIntervalSeconds?: number;
}

export class WalletDebitWorker {
  private walletDebitService: WalletDebitService;
  private pollingIntervalSeconds: number;

  constructor(
    walletDebitService?: WalletDebitService,
    options: WalletDebitWorkerOptions = {},
  ) {
    this.walletDebitService = walletDebitService ?? new WalletDebitService();
    this.pollingIntervalSeconds =
      options.pollingIntervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS;
  }

  async start(boss?: PgBoss): Promise<void> {
    const pgBoss = boss ?? getBoss();
    if (!pgBoss) {
      throw new Error("pg-boss is not initialized");
    }

    await pgBoss.createQueue(WALLET_DEBIT_QUEUE);

    await pgBoss.work<Record<string, never>>(
      WALLET_DEBIT_QUEUE,
      { pollingIntervalSeconds: this.pollingIntervalSeconds },
      async () => {
        await this.processBatchDebits();
      },
    );

    // Run daily at midnight UTC
    await pgBoss.schedule(WALLET_DEBIT_QUEUE, `0 0 * * *`);
  }

  async processBatchDebits(): Promise<{
    teamsProcessed: number;
    entriesCreated: number;
    itemsDebited: number;
  }> {
    const result = await this.walletDebitService.debitBatch();

    if (result.itemsDebited > 0) {
      console.log(
        `[wallet-debit-worker] Batch complete: ${result.teamsProcessed} teams, ` +
          `${result.entriesCreated} entries, ${result.itemsDebited} items debited`,
      );
    }

    return result;
  }
}
