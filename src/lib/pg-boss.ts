import PgBoss from "pg-boss";

let boss: PgBoss | undefined;

export function getBoss(): PgBoss | undefined {
  return boss;
}

export async function startBoss(databaseUrl: string): Promise<PgBoss> {
  if (boss) {
    return boss;
  }
  boss = new PgBoss(databaseUrl);
  await boss.start();
  return boss;
}

export async function stopBoss(): Promise<void> {
  if (boss) {
    await boss.stop({ graceful: true });
    boss = undefined;
  }
}
