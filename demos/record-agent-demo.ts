/** Local-only screen-recording surface. It streams a real agent run, never a canned transcript. */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { runAgentDemo } from "./agent-runner.ts";

const messages: string[] = [];
const listeners = new Set<import("node:http").ServerResponse>();
let state = "ready";
const log = (line: string) => {
  console.log(line);
  messages.push(line);
  for (const listener of listeners)
    listener.write(`data: ${JSON.stringify(line)}\n\n`);
};
const server = createServer(async (request, response) => {
  if (request.url === "/events" && request.method === "GET") {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    messages.forEach((line) =>
      response.write(`data: ${JSON.stringify(line)}\n\n`),
    );
    listeners.add(response);
    request.on("close", () => listeners.delete(response));
    return;
  }
  if (request.url === "/status") {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ state }));
    return;
  }
  if (request.url === "/run" && request.method === "POST") {
    // Only this local page can start a paid live-model run. Reject cross-origin requests.
    if (request.headers.origin !== "http://127.0.0.1:4318") {
      response.writeHead(403).end("Local page required");
      return;
    }
    if (state !== "ready") {
      response
        .writeHead(409)
        .end("A run has already started; restart the recorder to run again.");
      return;
    }
    state = "running";
    response.writeHead(202).end("Started");
    void runAgentDemo("docs/evidence", log).then(
      () => {
        state = "passed";
      },
      (error) => {
        state = "failed";
        log(`FAIL · ${error instanceof Error ? error.message : String(error)}`);
      },
    );
    return;
  }
  if (request.url === "/" && request.method === "GET") {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(
      await readFile(new URL("./agent-preview.html", import.meta.url), "utf8"),
    );
    return;
  }
  response.writeHead(404).end();
});
server.listen(4318, "127.0.0.1", () =>
  console.log("Agent recording page: http://127.0.0.1:4318"),
);
