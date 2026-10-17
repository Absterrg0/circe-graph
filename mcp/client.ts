/** Small stdio client used by the terminal UI and the process-level smoke test. */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export type PresentedRoute = ReturnType<
  typeof import("./server.ts").presentRoute
>;
export type PresentedClarification = ReturnType<
  typeof import("./server.ts").presentClarification
>;

export function createMcpClient() {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./server.ts", import.meta.url))],
    {
      stdio: ["pipe", "pipe", "inherit"],
      env: process.env,
    },
  );
  const lines = createInterface({ input: child.stdout });
  let nextId = 0;
  let terminalError: Error | undefined;
  let closing = false;
  const pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  const fail = (error: Error) => {
    terminalError = error;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  };
  child.on("error", fail);
  child.stdin.on("error", fail);
  child.on("exit", (code) => fail(new Error(`MCP server exited (${code})`)));
  lines.on("line", (line) => {
    try {
      const response = JSON.parse(line);
      const request = pending.get(response.id);
      if (request === undefined) return;
      pending.delete(response.id);
      clearTimeout(request.timer);
      if (response.error !== undefined)
        request.reject(new Error(response.error.message));
      else request.resolve(response.result);
    } catch {
      fail(new Error("MCP server returned invalid JSON"));
    }
  });
  const request = (
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (closing || terminalError !== undefined) {
        reject(terminalError ?? new Error("MCP client is closed"));
        return;
      }
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, 10_000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });
  return {
    pid: child.pid,
    async initialize() {
      await request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "circe-terminal", version: "0.3.0" },
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
      );
    },
    async call<T extends object>(
      name: string,
      args: Record<string, unknown> = {},
    ): Promise<T> {
      const result = (await request("tools/call", {
        name,
        arguments: args,
      })) as { isError?: boolean; content: Array<{ text: string }> };
      const text = result.content.map((item) => item.text).join("\n");
      if (result.isError) throw new Error(text);
      return JSON.parse(text);
    },
    async close() {
      closing = true;
      if (child.pid === undefined) {
        lines.close();
        return;
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        lines.close();
        return;
      }
      const exited = once(child, "exit");
      const timer = setTimeout(() => child.kill(), 2000);
      child.stdin.end();
      try {
        await exited;
      } finally {
        clearTimeout(timer);
        lines.close();
      }
    },
  };
}
