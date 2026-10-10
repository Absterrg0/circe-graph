/**
 * Adapted from circe-src/packages/circe-core/src/buildProjectVocabulary.test.ts.
 * The two behaviors under test are unchanged; the fixtures drop the Effect and
 * @circe/contracts types (ProjectId, DateTime) this standalone repo does not
 * depend on.
 */
import { describe, expect, it } from "vitest";

import { buildProjectVocabulary, groupCirceAliasesByProject } from "./buildProjectVocabulary.ts";

describe("buildProjectVocabulary", () => {
  it("combines live project identities with learned aliases and drops orphaned aliases", () => {
    expect(
      buildProjectVocabulary({
        projects: [
          {
            id: "project-rivvl",
            title: "Rivvl",
            workspaceRoot: "/work/rivvl-app",
            repositoryIdentity: {
              displayName: "acme/rivvl",
              name: "rivvl",
            },
          },
        ],
        aliases: [
          {
            projectId: "project-rivvl",
            alias: "ripple",
            kind: "confirmed-pronunciation",
          },
          {
            projectId: "project-deleted",
            alias: "old project",
            kind: "confirmed-pronunciation",
          },
        ],
      }),
    ).toEqual([
      {
        projectId: "project-rivvl",
        title: "Rivvl",
        workspaceRoot: "/work/rivvl-app",
        repositoryNames: ["acme/rivvl", "rivvl"],
        aliases: ["ripple"],
        aliasDetails: [{ alias: "ripple", kind: "confirmed-pronunciation" }],
      },
    ]);
  });

  it("matches the naive per-project filter exactly on an interleaved catalog", () => {
    const projects = Array.from({ length: 60 }, (_, index) => ({
      id: `project-${index}`,
      title: `Project ${index}`,
      workspaceRoot: `/work/project-${index}`,
      repositoryIdentity: undefined,
    }));
    // Interleave aliases across projects so grouping order matters.
    const aliases = Array.from({ length: 600 }, (_, index) => ({
      projectId: `project-${(index * 7) % 60}`,
      alias: `alias-${index}`,
      kind: "user-defined" as const,
    }));
    const grouped = groupCirceAliasesByProject(aliases);
    expect(grouped.size).toBe(60);
    expect(buildProjectVocabulary({ projects, aliases })).toEqual(
      projects.map((project) => ({
        projectId: project.id,
        title: project.title,
        workspaceRoot: project.workspaceRoot,
        repositoryNames: [],
        aliases: aliases
          .filter((alias) => alias.projectId === project.id)
          .map((alias) => alias.alias),
        aliasDetails: aliases
          .filter((alias) => alias.projectId === project.id)
          .map(({ alias, kind }) => ({ alias, kind })),
      })),
    );
  });
});
