/** Same as demos/record-agent-demo.ts, but writes the run's evidence to docs/evidence/final-run
 * so the earlier published evidence is not overwritten. Same page, same runner. */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { runAgentDemo } from "/home/abstergo/Programming/Hackathons/circe-graph/demos/agent-runner.ts";

const OUT = "docs/evidence/final-run";
const messages: string[] = [];
const listeners = new Set<import("node:http").ServerResponse>();
let state = "ready";
const log = (line: string) => {
  console.log(`${new Date().toISOString()} ${line}`);
  messages.push(line);
  for (const l of listeners) l.write(`data: ${JSON.stringify(line)}\n\n`);
};
createServer(async (req, res) => {
  if (req.url === "/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    messages.forEach((m) => res.write(`data: ${JSON.stringify(m)}\n\n`));
    listeners.add(res);
    req.on("close", () => listeners.delete(res));
    return;
  }
  if (req.url === "/status") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ state })); return; }
  if (req.url === "/run" && req.method === "POST") {
    if (req.headers.origin !== "http://127.0.0.1:4318") { res.writeHead(403).end("Local page required"); return; }
    if (state !== "ready") { res.writeHead(409).end("already started"); return; }
    state = "running"; res.writeHead(202).end("Started");
    void runAgentDemo(OUT, log).then(() => { state = "passed"; }, (e) => { state = "failed"; log(`FAIL · ${e instanceof Error ? e.message : String(e)}`); });
    return;
  }
  if (req.url === "/") { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(await readFile("/home/abstergo/Programming/Hackathons/circe-graph/demos/agent-preview.html", "utf8")); return; }
  res.writeHead(404).end();
}).listen(4318, "127.0.0.1", () => console.log("ready http://127.0.0.1:4318"));
