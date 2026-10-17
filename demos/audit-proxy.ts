/** Transparent recorder in front of the ordinary MCP server, used only by the agent demo. */
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const auditPath = process.env.CIRCE_DEMO_AUDIT;
if (!auditPath)
  throw new Error("CIRCE_DEMO_AUDIT is required for the recording proxy");
const child = spawn(
  process.execPath,
  [fileURLToPath(new URL("../mcp/server.ts", import.meta.url))],
  {
    stdio: ["pipe", "pipe", "inherit"],
    env: process.env,
  },
);
const record = (data: Record<string, unknown>) =>
  appendFileSync(
    auditPath,
    `${JSON.stringify({ at: new Date().toISOString(), stage: process.env.CIRCE_DEMO_STAGE, serverPid: child.pid, ...data })}\n`,
  );
record({ direction: "start" });
const requests = new Map<unknown, string>();
const input = createInterface({ input: process.stdin });
const output = createInterface({ input: child.stdout });
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "tools/call") {
    requests.set(request.id, request.params?.name);
    record({
      direction: "request",
      id: request.id,
      tool: request.params?.name,
      arguments: request.params?.arguments,
    });
  }
  child.stdin.write(`${line}\n`);
});
input.on("close", () => child.stdin.end());
output.on("line", (line) => {
  const response = JSON.parse(line);
  if (requests.has(response.id)) {
    record({
      direction: "response",
      id: response.id,
      tool: requests.get(response.id),
      result: response.result,
      error: response.error,
    });
    requests.delete(response.id);
  }
  process.stdout.write(`${line}\n`);
});
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
  input.close();
});
child.on("exit", (code) => {
  record({ direction: "exit", code });
  input.close();
  output.close();
  process.exitCode = code ?? 1;
});
