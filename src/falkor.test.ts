import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, expect, it } from "vitest";
import { closeGraph, getGraph, runCypher, runRead } from "./falkor.ts";
const exec = promisify(execFile);
afterAll(closeGraph);

it("concurrent first connections share one graph and the child exits after close", async () => {
  const { stdout } = await exec(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { getGraph, closeGraph } from './src/falkor.ts';
    const graphs = await Promise.all(Array.from({length: 12}, () => getGraph()));
    console.log(new Set(graphs).size);
    await closeGraph();
  `,
    ],
    {
      cwd: process.cwd(),
      timeout: 5000,
      env: { ...process.env, CIRCE_GRAPH: "circe_test_connections" },
    },
  );
  expect(stdout.trim()).toBe("1");
});

it("can reopen after shutdown races with the first connection", async () => {
  const { stdout } = await exec(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { getGraph, closeGraph, runRead } from './src/falkor.ts';
    try {
      await Promise.all([getGraph(), closeGraph()]);
      console.log(JSON.stringify(await runRead('RETURN 1 AS probe')));
    } finally { await closeGraph(); }
  `,
    ],
    {
      timeout: 5000,
      env: { ...process.env, CIRCE_GRAPH: "circe_test_connections" },
    },
  );
  expect(JSON.parse(stdout)).toEqual([{ probe: 1 }]);
});

it("switches graphs without leaking data and refuses writes through the read API", async () => {
  process.env.CIRCE_GRAPH = "circe_test_isolation_a";
  await (await getGraph()).query("MATCH (n) DETACH DELETE n");
  await runCypher("CREATE (:Project {id: 'private'})");
  process.env.CIRCE_GRAPH = "circe_test_isolation_b";
  await (await getGraph()).query("MATCH (n) DETACH DELETE n");
  expect(await runRead("MATCH (p:Project) RETURN p.id AS id")).toEqual([]);
  await expect(runRead("CREATE (:UnexpectedWrite)")).rejects.toThrow();
  expect(await runRead("MATCH (n:UnexpectedWrite) RETURN n")).toEqual([]);
  process.env.CIRCE_GRAPH = "circe_test_isolation_a";
  expect(await runRead("MATCH (p:Project) RETURN p.id AS id")).toEqual([
    { id: "private" },
  ]);
});
