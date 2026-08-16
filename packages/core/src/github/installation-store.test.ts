import type { Installation } from "@rivet/contracts";
import type { Executor, GithubInstallation, NewGithubInstallation } from "@rivet/database";
import { describe, expect, it } from "vitest";

import type { GitHubClient } from "./github";
import {
  getGitHubInstallation,
  listGitHubInstallations,
  syncGitHubInstallation,
  syncGitHubInstallations,
  upsertGitHubInstallation,
} from "./installation-store";

function installation(overrides: Partial<Installation> = {}): Installation {
  return {
    id: 42,
    accountLogin: "acme",
    accountType: "Organization",
    targetType: "Organization",
    permissions: { contents: "write", pull_requests: "write" },
    suspended: false,
    ...overrides,
  };
}

function rowFrom(values: NewGithubInstallation): GithubInstallation {
  return {
    createdAt: new Date(0),
    updatedAt: new Date(0),
    suspended: false,
    ...values,
  } as GithubInstallation;
}

function capturingExecutor(rows: GithubInstallation[] = []) {
  const inserted: NewGithubInstallation[] = [];
  const updates: Record<string, unknown>[] = [];
  const executor = {
    insert: () => ({
      values: (value: NewGithubInstallation) => {
        inserted.push(value);
        return {
          onConflictDoUpdate: (config: { set: Record<string, unknown> }) => {
            updates.push(config.set);
            return { returning: () => Promise.resolve([rowFrom(value)]) };
          },
        };
      },
    }),
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve(rows) }),
        orderBy: () => Promise.resolve(rows),
      }),
    }),
  } as unknown as Executor;

  return { executor, inserted, updates };
}

/** A client whose only job is to answer `listInstallations`. */
function fakeClient(installations: Installation[]): GitHubClient {
  return {
    listInstallations: () => Promise.resolve(installations),
  } as unknown as GitHubClient;
}

describe("upsertGitHubInstallation", () => {
  it("writes every column and maps the row back to the contract", async () => {
    const capture = capturingExecutor();

    const stored = await upsertGitHubInstallation(installation(), capture.executor);

    expect(capture.inserted).toEqual([
      {
        id: 42,
        accountLogin: "acme",
        accountType: "Organization",
        targetType: "Organization",
        permissions: { contents: "write", pull_requests: "write" },
        suspended: false,
      },
    ]);
    expect(stored).toEqual(installation());
  });

  it("refreshes the provider snapshot on conflict rather than doing nothing", async () => {
    const capture = capturingExecutor();

    await upsertGitHubInstallation(installation({ suspended: true }), capture.executor);

    // A permissions or suspension change that did not land would leave the
    // control plane offering a repository the App can no longer write to.
    const [set] = capture.updates;
    expect(set).toMatchObject({ accountLogin: "acme", suspended: true });
    expect(set?.updatedAt).toBeInstanceOf(Date);
    expect(set).not.toHaveProperty("createdAt");
  });
});

describe("getGitHubInstallation", () => {
  it("returns null when Rivet has never seen the installation", async () => {
    const capture = capturingExecutor([]);
    expect(await getGitHubInstallation(42, capture.executor)).toBeNull();
  });

  it("maps a persisted row to the contract", async () => {
    const capture = capturingExecutor([rowFrom(installation())]);
    expect(await getGitHubInstallation(42, capture.executor)).toEqual(installation());
  });
});

describe("listGitHubInstallations", () => {
  it("maps every persisted row", async () => {
    const capture = capturingExecutor([
      rowFrom(installation()),
      rowFrom(installation({ id: 7, accountLogin: "hieu" })),
    ]);

    expect(await listGitHubInstallations(capture.executor)).toEqual([
      installation(),
      installation({ id: 7, accountLogin: "hieu" }),
    ]);
  });
});

describe("syncGitHubInstallations", () => {
  it("persists what the provider reports and returns the persisted rows", async () => {
    const capture = capturingExecutor();
    const client = fakeClient([installation(), installation({ id: 7, accountLogin: "hieu" })]);

    const synced = await syncGitHubInstallations(client, capture.executor);

    expect(synced.map((entry) => entry.id)).toEqual([42, 7]);
    expect(capture.inserted).toHaveLength(2);
  });
});

describe("syncGitHubInstallation", () => {
  it("selects the callback's installation and persists it", async () => {
    const capture = capturingExecutor();
    const client = fakeClient([installation({ id: 7 }), installation()]);

    expect(await syncGitHubInstallation(client, 42, capture.executor)).toEqual(installation());
    expect(capture.inserted).toEqual([expect.objectContaining({ id: 42 })]);
  });

  it("persists nothing when the App cannot act on the callback's installation", async () => {
    const capture = capturingExecutor();
    const client = fakeClient([installation({ id: 7 })]);

    expect(await syncGitHubInstallation(client, 42, capture.executor)).toBeNull();
    expect(capture.inserted).toEqual([]);
  });
});
