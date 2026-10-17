# Submission copy

Eligibility status: pending organizer clarification. See [the disclosed timeline](provenance.md) before submitting this entry. This draft must not be presented as confirmation that the project meets the event's start-date requirement.

## Project

circe-graph: shared, explainable project memory for coding agents.

Primary track: Track 2, Agent Memory and Coordination.

## Problem

A coding assistant needs to know which project a user means, which machine owns it, and what earlier sessions learned. Similar project names and speech-recognition mistakes can send work to the wrong workspace. A previous choice is useful context, but it should not erase a real ambiguity.

## What it does

circe-graph exposes a FalkorDB-backed memory and routing service over MCP. A coding agent can ask about a project, obtain machine-qualified choices, record the user's confirmation, and recall that decision in a later process.

One confirmation turns "Zivil" into a confirmed pronunciation of Rivvl, linked to the utterance that taught it. A new agent process resolves the same request from graph memory. Two projects called Portfolio still require a choice; the graph shows the user's previous answer without silently applying it.

The same graph connects machines, projects, and tasks. An offline-machine query returns the affected work and any same-title copy on another machine, with the relationship paths behind the answer. A same-title copy is reported as a candidate, not certified as identical or automatically selected.

## Why FalkorDB is central

Candidate lookup, confirmed aliases, episodes, clarification precedent, ownership, and task relationships live in the graph. The service queries FalkorDB for each route and question. Removing it removes the service's source of truth; there is no parallel in-memory fallback catalog.

The model selects from seven fixed tools. The service executes reviewed, parameterized Cypher rather than model-written queries. Four question tools use the database's read-only query API. Routing and follow-up tools deliberately write memory, and their MCP annotations identify that behavior.

## Demonstration and setup

The README provides local setup using Node 24, pnpm, and Docker. No public deployment is required to run the service. The deterministic conversation demo requires no model API key. The optional Codex integration demo uses a separately authenticated local Codex CLI and real model-selected tool calls.

The seeded machines, workspaces, tasks, and conversations are synthetic. The service does not run coding tasks or provide speech recognition; those belong to its host.

## Original work and AI assistance

The initial FalkorDB prototype was committed October 11, before the event. Event additions include confirmed-alias learning and provenance, memory recall, clarification precedent, question tools, MCP integration, correctness fixes, and demonstration materials. The organizer must decide whether these additions can be judged given the pre-event prototype.

AI coding assistants wrote and reviewed code, ran tests, and prepared documentation under participant direction. The participant remains responsible for verifying the submission and explaining its architecture and decisions. The full provenance document identifies reused Circe code and the repository timeline.
