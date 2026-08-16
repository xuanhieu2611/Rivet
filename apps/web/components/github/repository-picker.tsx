"use client";

import type { Installation, Issue, Repository } from "@rivet/contracts";
import { useCallback, useEffect, useState } from "react";

import { cn } from "@/lib/utils";
import { fetchInstallations, fetchIssues, fetchRepositories } from "@/lib/github/browser";

/** What the form records on the job when a repository is picked. */
export interface RepositorySelection {
  installationId: number;
  owner: string;
  name: string;
  repoUrl: string;
  defaultBranch: string;
}

/** What the form records - and prefills from - when an issue is picked. */
export interface IssueSelection {
  number: number;
  url: string;
  title: string;
  body: string | null;
}

interface RepositoryPickerProps {
  onRepositoryChange: (selection: RepositorySelection | null) => void;
  onIssueChange: (selection: IssueSelection | null) => void;
  /** Told when GitHub cannot answer at all, so the form can disclose the manual field. */
  onUnavailable: (reason: string) => void;
  disabled?: boolean;
}

/**
 * Installation, then repository, then optionally issue.
 *
 * Three dependent selects rather than one search box: an installation reaches a
 * handful of repositories by design - §20's "as narrow as practical" is about
 * this list being short - and a select that shows everything at once is more
 * honest about that than a field that hides it behind typing.
 *
 * Every list is fetched on demand and every failure is reported in place. The
 * component never throws the form into an error state; the manual repository URL
 * is always still there.
 */
export function RepositoryPicker({
  onRepositoryChange,
  onIssueChange,
  onUnavailable,
  disabled,
}: RepositoryPickerProps) {
  const [installations, setInstallations] = useState<Installation[] | null>(null);
  const [installationId, setInstallationId] = useState<number | null>(null);
  const [repositories, setRepositories] = useState<Repository[] | null>(null);
  const [repositoryKey, setRepositoryKey] = useState<string>("");
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [issueNumber, setIssueNumber] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reportUnavailable = useCallback(
    (reason: string) => {
      setError(reason);
      onUnavailable(reason);
    },
    [onUnavailable],
  );

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const result = await fetchInstallations();
      if (cancelled) return;
      setLoading(false);
      if (!result.ok) {
        reportUnavailable(result.error);
        return;
      }
      setInstallations(result.value.installations);
      // One installation is the common case on a machine running Rivet locally,
      // and making somebody choose from a list of one is a click that teaches
      // them nothing.
      const only = result.value.installations.length === 1 ? result.value.installations[0] : null;
      if (only) setInstallationId(only.id);
    })();

    return () => {
      cancelled = true;
    };
  }, [reportUnavailable]);

  useEffect(() => {
    if (installationId === null) {
      setRepositories(null);
      return;
    }

    let cancelled = false;
    setRepositories(null);
    setRepositoryKey("");
    onRepositoryChange(null);
    onIssueChange(null);
    setIssues(null);
    setIssueNumber(null);

    void (async () => {
      const result = await fetchRepositories(installationId);
      if (cancelled) return;
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setError(null);
      setRepositories(result.value.repositories);
    })();

    return () => {
      cancelled = true;
    };
  }, [installationId, onIssueChange, onRepositoryChange]);

  const selectRepository = (key: string) => {
    setRepositoryKey(key);
    setIssues(null);
    setIssueNumber(null);
    onIssueChange(null);

    const repository = repositories?.find((entry) => repositoryKeyOf(entry) === key);
    if (!repository || installationId === null) {
      onRepositoryChange(null);
      return;
    }

    onRepositoryChange({
      installationId,
      owner: repository.owner,
      name: repository.name,
      repoUrl: `https://github.com/${repository.owner}/${repository.name}`,
      defaultBranch: repository.defaultBranch,
    });

    void (async () => {
      const result = await fetchIssues(installationId, repository.owner, repository.name);
      // An unreadable issue list is not a reason to block the job: the
      // description field is the task, and the issue is a convenience.
      setIssues(result.ok ? result.value.issues : []);
      if (!result.ok) setError(result.error);
    })();
  };

  const selectIssue = (raw: string) => {
    if (raw === "") {
      setIssueNumber(null);
      onIssueChange(null);
      return;
    }

    const number = Number(raw);
    const issue = issues?.find((entry) => entry.number === number);
    setIssueNumber(issue ? issue.number : null);
    onIssueChange(
      issue
        ? { number: issue.number, url: issue.htmlUrl, title: issue.title, body: issue.body }
        : null,
    );
  };

  if (loading) {
    return <p className="text-muted-foreground text-sm">Loading GitHub installations…</p>;
  }

  if (installations === null) {
    return <p className="text-muted-foreground text-sm">{error ?? "GitHub is unavailable."}</p>;
  }

  if (installations.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        The App is not installed anywhere yet. Install it from{" "}
        <a href="/settings/github" className="text-sky-700 hover:underline dark:text-sky-300">
          the GitHub settings page
        </a>
        , then come back.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {installations.length > 1 ? (
        <PickerField label="Account" htmlFor="installation">
          <PickerSelect
            id="installation"
            value={installationId === null ? "" : String(installationId)}
            onChange={(value) => setInstallationId(value === "" ? null : Number(value))}
            disabled={disabled}
          >
            <option value="">Choose an account…</option>
            {installations.map((installation) => (
              <option key={installation.id} value={installation.id}>
                {installation.accountLogin}
                {installation.suspended ? " (suspended)" : ""}
              </option>
            ))}
          </PickerSelect>
        </PickerField>
      ) : null}

      <PickerField
        label="Repository"
        htmlFor="repository"
        hint={repositories === null && installationId !== null ? "Loading…" : undefined}
      >
        <PickerSelect
          id="repository"
          value={repositoryKey}
          onChange={selectRepository}
          disabled={disabled === true || repositories === null || repositories.length === 0}
        >
          <option value="">
            {repositories?.length === 0
              ? "This installation reaches no repositories"
              : "Choose a repository…"}
          </option>
          {(repositories ?? []).map((repository) => (
            <option key={repository.id} value={repositoryKeyOf(repository)}>
              {repository.owner}/{repository.name}
              {repository.private ? " (private)" : ""}
            </option>
          ))}
        </PickerSelect>
      </PickerField>

      <PickerField
        label="Issue"
        htmlFor="issue"
        hint="Optional. Prefills the title and description."
      >
        <PickerSelect
          id="issue"
          value={issueNumber === null ? "" : String(issueNumber)}
          onChange={selectIssue}
          disabled={disabled === true || repositoryKey === "" || issues === null}
        >
          <option value="">
            {repositoryKey === ""
              ? "Pick a repository first"
              : issues === null
                ? "Loading issues…"
                : issues.length === 0
                  ? "No open issues"
                  : "No issue"}
          </option>
          {(issues ?? []).map((issue) => (
            <option key={issue.number} value={issue.number}>
              #{issue.number} {issue.title}
            </option>
          ))}
        </PickerSelect>
      </PickerField>

      {error ? <p className="text-destructive text-xs">{error}</p> : null}
    </div>
  );
}

function repositoryKeyOf(repository: Repository): string {
  return `${repository.owner}/${repository.name}`;
}

function PickerField({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={htmlFor} className="text-sm font-medium">
          {label}
        </label>
        {hint ? <span className="text-muted-foreground text-xs">{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}

/**
 * A native select wearing the Input styles.
 *
 * shadcn's Select is a listbox built on Radix and would be the first component
 * in this app to need one. Three dependent dropdowns do not justify it, and a
 * native select keeps keyboard behaviour and mobile pickers for free.
 */
function PickerSelect({
  id,
  value,
  onChange,
  disabled,
  children,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean | undefined;
  children: React.ReactNode;
}) {
  return (
    <select
      id={id}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      disabled={disabled}
      className={cn(
        "border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 h-8 w-full min-w-0 rounded-lg border px-2 py-1 text-sm transition-colors outline-none focus-visible:ring-3",
        "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
      )}
    >
      {children}
    </select>
  );
}
