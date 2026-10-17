/** Interactive terminal host for the same MCP tools a coding agent calls. */
import { createInterface, type Interface } from "node:readline";
import {
  createMcpClient,
  type PresentedRoute,
  type PresentedClarification,
} from "./client.ts";
import type { AskResult } from "../src/ask.ts";
import { graphName } from "../src/falkor.ts";

const client = createMcpClient();
let input: Interface | undefined;
console.log(
  `Circe graph · ${graphName()}\nType a request, or /running, /blast build-box, /why zivil, /history Rivvl, /cancel, /quit.`,
);
let pending: { utterance: string; projectId?: string } | undefined;
try {
  await client.initialize();
  input = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY,
  });
  if (process.stdin.isTTY) {
    input.setPrompt("You > ");
    input.prompt();
  }
  for await (const raw of input) {
    const text = raw.trim();
    if (text === "/quit") break;
    if (text === "") {
      if (process.stdin.isTTY) input.prompt();
      continue;
    }
    if (text === "/cancel") {
      pending = undefined;
      if (process.stdin.isTTY) input.prompt();
      continue;
    }
    const originalUtterance = pending?.utterance ?? text;
    try {
      let result: PresentedRoute | PresentedClarification | AskResult;
      if (text === "/running")
        result = await client.call<AskResult>("whats_running");
      else if (text.startsWith("/blast "))
        result = await client.call<AskResult>("machine_blast_radius", {
          machine: text.slice(7),
          depth: 2,
        });
      else if (text.startsWith("/why "))
        result = await client.call<AskResult>("why_heard", {
          text: text.slice(5),
        });
      else if (text.startsWith("/history "))
        result = await client.call<AskResult>("project_history", {
          project: text.slice(9),
        });
      else if (text.startsWith("/")) {
        console.log(
          "Commands: /running, /blast <machine>, /why <name>, /history <project>, /cancel, /quit.",
        );
        if (process.stdin.isTTY) input.prompt();
        continue;
      } else if (pending?.projectId !== undefined) {
        if (/^(?:no|nope|cancel)$/iu.test(text)) {
          pending = undefined;
          console.log("Confirmation cancelled.");
          if (process.stdin.isTTY) input.prompt();
          continue;
        }
        if (!/^(?:yes|yeah|yep|correct|confirm)$/iu.test(text)) {
          console.log("Answer yes or no, or /cancel to start another request.");
          if (process.stdin.isTTY) input.prompt();
          continue;
        }
        result = await client.call<PresentedRoute>("confirm_route", {
          utterance: pending.utterance,
          projectId: pending.projectId,
        });
      } else if (pending !== undefined)
        result = await client.call<PresentedClarification>(
          "answer_clarification",
          { utterance: pending.utterance, answer: text },
        );
      else
        result = await client.call<PresentedRoute>("route_request", {
          utterance: text,
        });
      console.log(
        `Circe > ${"summary" in result ? result.summary : result.resolved && result.project ? `Selected ${result.project.title} on ${result.project.machine.name}.` : "That answer did not select an offered project."}`,
      );
      if (result.outcome !== undefined) console.log(`  ${result.outcome}`);
      if ("disconnectedMachine" in result && result.disconnectedMachine)
        console.log(
          `  Machine offline: ${result.disconnectedMachine.name}. ${result.disconnectedMachine.reason ?? ""}`,
        );
      if ("lastMeant" in result && result.lastMeant)
        console.log(`  Last time: ${result.lastMeant.label}.`);
      if ("learned" in result && result.learned)
        console.log(`  Learned pronunciation: ${result.learned.text}.`);
      if (Array.isArray(result.paths))
        result.paths.forEach((path: string) => console.log(`  ${path}`));
      if (!text.startsWith("/")) {
        if (
          "status" in result &&
          result.status === "needs-confirmation" &&
          result.project
        )
          pending = {
            utterance: originalUtterance,
            projectId: result.project.id,
          };
        else if ("status" in result && result.status === "needs-clarification")
          pending = { utterance: originalUtterance };
        else if (!("resolved" in result) || result.resolved !== false)
          pending = undefined;
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
    }
    if (process.stdin.isTTY) input.prompt();
  }
} finally {
  input?.close();
  await client.close();
}
