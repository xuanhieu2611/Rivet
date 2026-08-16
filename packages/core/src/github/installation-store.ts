import type { Installation } from "@rivet/contracts";
import {
  db,
  type Executor,
  type GithubInstallation,
  githubInstallations,
  type NewGithubInstallation,
} from "@rivet/database";
import { asc, eq } from "drizzle-orm";

import type { GitHubClient } from "./github";

/**
 * The only writer of `github_installations`.
 *
 * GitHub owns the truth about which installations exist and what they can do;
 * this table is Rivet's durable copy of it, keyed by GitHub's own installation
 * id so a callback URL carrying `installation_id` addresses the row directly.
 * Milestone 11 adds an owner column to this table rather than a table beside it,
 * which is why the id is GitHub's rather than a Rivet surrogate.
 *
 * There is no login in Milestone 9, so a row here is usable by anybody who can
 * reach the app. `SECURITY.md` states that in as many words; it is a deliberate
 * deferral rather than an oversight.
 */
export type UpsertGitHubInstallationInput = Installation;

/**
 * Inserts or refreshes one installation row.
 *
 * The upsert is a real update rather than `DO NOTHING`: unlike the append-only
 * ledgers in this system, an installation row is a cache of provider state, and
 * a stale permissions snapshot is worse than no snapshot. `created_at` is left
 * alone so the row still records when Rivet first saw the installation.
 */
export async function upsertGitHubInstallation(
  input: UpsertGitHubInstallationInput,
  executor: Executor = db,
): Promise<Installation> {
  const values: NewGithubInstallation = {
    id: input.id,
    accountLogin: input.accountLogin,
    accountType: input.accountType,
    targetType: input.targetType,
    permissions: input.permissions,
    suspended: input.suspended,
  };

  const [row] = await executor
    .insert(githubInstallations)
    .values(values)
    .onConflictDoUpdate({
      target: githubInstallations.id,
      set: {
        accountLogin: values.accountLogin,
        accountType: values.accountType,
        targetType: values.targetType,
        permissions: values.permissions,
        suspended: values.suspended,
        updatedAt: new Date(),
      },
    })
    .returning();

  if (!row) {
    throw new Error(`Upserting GitHub installation ${String(input.id)} returned no row.`);
  }
  return toInstallation(row);
}

/** Reads one persisted installation, or null when Rivet has never seen it. */
export async function getGitHubInstallation(
  installationId: number,
  executor: Executor = db,
): Promise<Installation | null> {
  const [row] = await executor
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.id, installationId))
    .limit(1);

  return row ? toInstallation(row) : null;
}

/** Reads every persisted installation, oldest first. */
export async function listGitHubInstallations(executor: Executor = db): Promise<Installation[]> {
  const rows = await executor
    .select()
    .from(githubInstallations)
    .orderBy(asc(githubInstallations.id));

  return rows.map(toInstallation);
}

/**
 * Lists installations from GitHub and refreshes the durable copy of each.
 *
 * The provider is the source of truth and the table is the cache, so a read of
 * the control-plane surface goes to the API and persists what it learns. That
 * ordering is what makes an App that was uninstalled or suspended between two
 * page loads visible on the second one - Milestone 9 subscribes to no webhooks,
 * so pulling on demand is the only way Rivet ever learns.
 *
 * Rows for installations GitHub no longer returns are left in place rather than
 * deleted: jobs reference `github_installation_id`, and a job's history should
 * still name the installation it ran under.
 */
export async function syncGitHubInstallations(
  client: GitHubClient,
  executor: Executor = db,
): Promise<Installation[]> {
  const installations = await client.listInstallations();
  const persisted: Installation[] = [];
  for (const installation of installations) {
    persisted.push(await upsertGitHubInstallation(installation, executor));
  }
  return persisted;
}

/**
 * Refreshes one installation by id, for the App's post-install callback.
 *
 * GitHub's setup redirect carries an installation id and nothing else, and the
 * App JWT can list installations but cannot be told to fetch one it does not
 * have. Listing and selecting is therefore the whole operation; a null result
 * means the id in the callback is not one this App can act on, which the caller
 * reports rather than persisting a row for.
 */
export async function syncGitHubInstallation(
  client: GitHubClient,
  installationId: number,
  executor: Executor = db,
): Promise<Installation | null> {
  const installations = await client.listInstallations();
  const match = installations.find((installation) => installation.id === installationId);
  if (!match) return null;
  return upsertGitHubInstallation(match, executor);
}

/** Maps the loose jsonb column to the contract consumed by the domain. */
export function toInstallation(row: GithubInstallation): Installation {
  return {
    id: row.id,
    accountLogin: row.accountLogin,
    accountType: row.accountType,
    targetType: row.targetType,
    permissions: row.permissions,
    suspended: row.suspended,
  };
}
