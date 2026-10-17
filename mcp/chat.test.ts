import { execFile } from "node:child_process";
import { expect, it } from "vitest";
import { closeGraph, getGraph } from "../src/falkor.ts";
import { seedGraph } from "../src/seedGraph.ts";

it("runs a piped conversation with rejection, confirmation, recall, and clarification", async () => {
  process.env.CIRCE_GRAPH = "circe_test_chat";
  try {
    await seedGraph(await getGraph());
  } finally {
    await closeGraph();
  }
  const { stdout, stderr } = await new Promise<{
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    const child = execFile(
      process.execPath,
      ["mcp/chat.ts"],
      { env: process.env, timeout: 10_000 },
      (error, stdout, stderr) => {
        if (error) reject(error);
        else resolve({ stdout, stderr });
      },
    );
    child.stdin?.end(
      "Open Zivil.\nno\nOpen Zivil.\nyes\nOpen Zivil.\nOpen Portfolio.\nmoonbase\nlaptop\n/blast build-box\n/quit\n",
    );
  });
  expect(stderr).toBe("");
  expect(stdout).toContain("Confirmation cancelled.");
  expect(stdout).toContain("Learned pronunciation: zivil.");
  expect(stdout).toContain("answered_from_memory");
  expect(stdout).toContain("That answer did not select an offered project.");
  expect(stdout).toContain("Selected Portfolio on laptop.");
  expect(stdout).toContain("refresh the portfolio theme");
});
