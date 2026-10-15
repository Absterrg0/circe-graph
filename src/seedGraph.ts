/**
 * Seed graph for circe-graph.
 *
 * Machines: desktop and laptop are connected; build-box is the disconnected
 * machine the route must report instead of silently rerouting work to
 * laptop's copy of the same project.
 *
 * Schema (v2 — designed around the questions the agent asks):
 *   (:User)-[:SAID]->(:Utterance)-[:RESOLVED_TO {match}]->(:Project)
 *   (:Machine)-[:OWNS]->(:Project)-[:HAS]->(:Task)
 *   (:Project)-[:LEARNED_ALIAS {source, ts}]->(:Alias {text, kind})
 *   (:Utterance)-[:TAUGHT]->(:Alias)                 -- provenance, written at runtime
 *   (:Episode:Memory {text, ts, status})-[:ABOUT]->(:Project)
 *   (:Heard {text})-[:LAST_MEANT {ts}]->(:Project)   -- written when a clarification is answered
 *
 * Alias ownership moved from Task to Project: an alias is semantic memory for
 * the *project* it names, and its kind says how strong that memory is —
 * "hint" (heard once, gates recall only, so the core still reports an honest
 * near match) or "confirmed" (the user said "yes, that's what I meant", joins
 * the project's names, and makes the next session resolve instantly).
 */
import type { Graph } from "falkordb";

export const SEED_IDS = {
  user: "user-local",
  machineDesktop: "machine-desktop",
  machineLaptop: "machine-laptop",
  machineBuildBox: "machine-build-box",
  rivvl: "project-rivvl-desktop",
  portfolioLaptop: "project-portfolio-laptop",
  portfolioBuildBox: "project-portfolio-build-box",
  taskFixLogin: "task-fix-login",
  taskPolishHomepage: "task-polish-homepage",
  taskRefreshTheme: "task-refresh-theme",
  aliasRival: "alias-rival",
  episodeLoginCheck: "episode-rivvl-login-check",
  episodeLoginRedirect: "episode-rivvl-login-redirect",
  episodePortfolioCopy: "episode-portfolio-copy",
} as const;

/** FalkorDB rejects multi-statement queries, so each statement runs alone. */
export const SEED_STATEMENTS: ReadonlyArray<string> = [
  `CREATE (:User {id: '${SEED_IDS.user}', name: 'You'})`,
  `CREATE (:Machine {id: '${SEED_IDS.machineDesktop}', name: 'desktop', connected: true}),
          (:Machine {id: '${SEED_IDS.machineLaptop}', name: 'laptop', connected: true}),
          (:Machine {id: '${SEED_IDS.machineBuildBox}', name: 'build-box', connected: false,
                     disconnectedReason: 'offline since 2026-10-09'})`,
  `CREATE (:Project {id: '${SEED_IDS.rivvl}', title: 'Rivvl', workspaceRoot: '/home/you/code/rivvl'}),
          (:Project {id: '${SEED_IDS.portfolioLaptop}', title: 'Portfolio', workspaceRoot: '/home/you/code/portfolio'}),
          (:Project {id: '${SEED_IDS.portfolioBuildBox}', title: 'Portfolio', workspaceRoot: '/srv/portfolio'})`,
  `MATCH (m:Machine {id: '${SEED_IDS.machineDesktop}'}), (p:Project {id: '${SEED_IDS.rivvl}'})
   CREATE (m)-[:OWNS]->(p)`,
  `MATCH (m:Machine {id: '${SEED_IDS.machineLaptop}'}), (p:Project {id: '${SEED_IDS.portfolioLaptop}'})
   CREATE (m)-[:OWNS]->(p)`,
  `MATCH (m:Machine {id: '${SEED_IDS.machineBuildBox}'}), (p:Project {id: '${SEED_IDS.portfolioBuildBox}'})
   CREATE (m)-[:OWNS]->(p)`,
  `CREATE (:Task {id: '${SEED_IDS.taskFixLogin}', title: 'fix the login bug', state: 'queued'}),
          (:Task {id: '${SEED_IDS.taskPolishHomepage}', title: 'polish the homepage', state: 'running'}),
          (:Task {id: '${SEED_IDS.taskRefreshTheme}', title: 'refresh the portfolio theme', state: 'queued'})`,
  `MATCH (p:Project {id: '${SEED_IDS.rivvl}'}), (t:Task {id: '${SEED_IDS.taskFixLogin}'})
   CREATE (p)-[:HAS]->(t)`,
  `MATCH (p:Project {id: '${SEED_IDS.portfolioLaptop}'}), (t:Task {id: '${SEED_IDS.taskPolishHomepage}'})
   CREATE (p)-[:HAS]->(t)`,
  `MATCH (p:Project {id: '${SEED_IDS.portfolioBuildBox}'}), (t:Task {id: '${SEED_IDS.taskRefreshTheme}'})
   CREATE (p)-[:HAS]->(t)`,
  // One learned alias: voice heard "rival" for Rivvl. It gates candidate recall
  // but is only a hint — the core still reports a near match, never exact.
  `CREATE (:Alias {id: '${SEED_IDS.aliasRival}', text: 'rival', kind: 'hint',
                   ts: '2026-10-08T09:12:00.000Z'})`,
  `MATCH (p:Project {id: '${SEED_IDS.rivvl}'}), (a:Alias {id: '${SEED_IDS.aliasRival}'})
   CREATE (p)-[:LEARNED_ALIAS {source: 'seed', ts: '2026-10-08T09:12:00.000Z'}]->(a)`,
  // Episodic memory: what the graph already knows about projects, newest last.
  `MATCH (p:Project {id: '${SEED_IDS.rivvl}'})
   CREATE (e:Episode:Memory {id: '${SEED_IDS.episodeLoginCheck}',
                             text: 'checked whether the login flow works in Rivvl',
                             ts: '2026-10-09T17:40:00.000Z', status: 'resolved'})
   CREATE (e)-[:ABOUT]->(p)`,
  `MATCH (p:Project {id: '${SEED_IDS.rivvl}'})
   CREATE (e:Episode:Memory {id: '${SEED_IDS.episodeLoginRedirect}',
                             text: 'started fixing the login redirect in Rivvl',
                             ts: '2026-10-10T09:05:00.000Z', status: 'resolved'})
   CREATE (e)-[:ABOUT]->(p)`,
  `MATCH (p:Project {id: '${SEED_IDS.portfolioLaptop}'})
   CREATE (e:Episode:Memory {id: '${SEED_IDS.episodePortfolioCopy}',
                             text: 'reviewed the portfolio homepage copy',
                             ts: '2026-10-09T11:20:00.000Z', status: 'resolved'})
   CREATE (e)-[:ABOUT]->(p)`,
];

/** Drop everything and recreate the seed. Safe to run repeatedly. */
export async function seedGraph(graph: Graph): Promise<void> {
  await graph.query("MATCH (n) DETACH DELETE n");
  for (const statement of SEED_STATEMENTS) {
    await graph.query(statement);
  }
}
