/**
 * Fail fast with a readable message when FalkorDB is not up. `pnpm test`
 * should tell you to start Docker, not drown you in ECONNREFUSED stacks.
 */
import { connect } from "node:net";

const host = process.env.FALKOR_HOST ?? "localhost";
const port = Number(process.env.FALKOR_PORT ?? 6379);

export default async function globalSetup(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = connect({ host, port });
    const fail = (detail?: string): void => {
      socket.destroy();
      reject(
        new Error(
          `FalkorDB is not reachable at ${host}:${port} — start it with: docker compose up -d${
            detail === undefined ? "" : ` (${detail})`
          }`,
        ),
      );
    };
    socket.setTimeout(2_000, () => fail("connection timed out"));
    socket.once("connect", () => {
      socket.end();
      resolve();
    });
    socket.once("error", (error) => fail((error as Error).message));
  });
}
