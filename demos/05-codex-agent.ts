import { runAgentDemo } from "./agent-runner.ts";

try {
  await runAgentDemo(process.argv[2] ?? ".agent-demo");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
