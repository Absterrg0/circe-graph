import { closeGraph, runRead } from "./src/falkor.ts";

export default async function globalSetup(): Promise<void> {
  try {
    await runRead("RETURN 1 AS probe");
  } catch {
    throw new Error(
      "FalkorDB is not reachable with the configured connection. Start it with: pnpm db:up, or check FALKOR_URL / FALKOR_HOST / FALKOR_PORT.",
    );
  } finally {
    await closeGraph();
  }
}
