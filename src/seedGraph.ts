/**
 * Seed graph for circe-graph.
 *
 * The brief calls for 2 Machines (desktop, laptop) and 3 Projects. The third
 * project — Portfolio on build-box — needs a machine to own it, and that
 * machine is the disconnected one the route must report instead of rerouting
 * to laptop. So the graph seeds desktop and laptop as connected machines plus
 * build-box as a disconnected machine.
 *
 * Every OWNS edge means "this machine can run this project". Duplicate titles
 * across machines are deliberate: they are what forces clarification.
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
  aliasRival: "alias-rival",
  episodeSeed: "episode-seed-1",
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
          (:Task {id: '${SEED_IDS.taskPolishHomepage}', title: 'polish the homepage', state: 'running'})`,
  `MATCH (p:Project {id: '${SEED_IDS.rivvl}'}), (t:Task {id: '${SEED_IDS.taskFixLogin}'})
   CREATE (p)-[:HAS]->(t)`,
  `MATCH (p:Project {id: '${SEED_IDS.portfolioLaptop}'}), (t:Task {id: '${SEED_IDS.taskPolishHomepage}'})
   CREATE (p)-[:HAS]->(t)`,
  // One learned alias: voice heard "rival" while working the login task and the
  // user confirmed Rivvl, so the graph remembers the mishearing.
  `CREATE (:Alias {id: '${SEED_IDS.aliasRival}', text: 'rival', learnedFrom: 'voice',
                   ts: '2026-10-08T09:12:00.000Z'})`,
  `MATCH (t:Task {id: '${SEED_IDS.taskFixLogin}'}), (a:Alias {id: '${SEED_IDS.aliasRival}'})
   CREATE (t)-[:LEARNED_ALIAS]->(a)`,
  `CREATE (:Episode:Memory {id: '${SEED_IDS.episodeSeed}',
                            text: 'checked whether the login flow works in Rivvl',
                            ts: '2026-10-09T17:40:00.000Z', status: 'resolved'})`,
];

/** Drop everything and recreate the seed. Safe to run repeatedly. */
export async function seedGraph(graph: Graph): Promise<void> {
  await graph.query("MATCH (n) DETACH DELETE n");
  for (const statement of SEED_STATEMENTS) {
    await graph.query(statement);
  }
}
