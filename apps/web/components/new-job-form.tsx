"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import {
  type CreateJob,
  type CreateJobInput,
  createJobSchema,
  JOB_BUDGET_DEFAULTS,
  type JobDetail,
} from "@rivet/contracts";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";

import {
  type IssueSelection,
  RepositoryPicker,
  type RepositorySelection,
} from "@/components/github/repository-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { ApiErrorBody } from "@/lib/api/responses";
import { formatDuration, formatUsd } from "@/lib/format";

const FIELDS = [
  "title",
  "description",
  "repoUrl",
  "baseBranch",
  "githubInstallationId",
  "repoOwner",
  "repoName",
  "issueNumber",
  "issueUrl",
] as const;
type FieldName = (typeof FIELDS)[number];

function isFieldName(value: string): value is FieldName {
  return (FIELDS as readonly string[]).includes(value);
}

/**
 * The only interactive component on the create path.
 *
 * Validation is `createJobSchema` from `@rivet/contracts` - the exact schema the
 * route handler runs - so the client cannot drift from the server. Field errors
 * the server returns anyway (a race, or a rule the client build predates) are
 * pushed back onto the matching inputs rather than swallowed.
 *
 * Milestone 9 adds the GitHub binding. A picked repository fills `repoUrl` along
 * with the installation, owner and name that let `finalizing` publish; the
 * manual URL stays as a disclosed fallback, and a job created through it runs
 * the whole pipeline and records that publication was skipped. That fallback is
 * not a courtesy: it is the path every fixture, `demo:job` and `demo:recovery`
 * take, and it must keep working with no GitHub App at all.
 */
export function NewJobForm({ githubEnabled }: { githubEnabled: boolean }) {
  const router = useRouter();
  const [mode, setMode] = useState<"picker" | "manual">(githubEnabled ? "picker" : "manual");
  const [pickerUnavailable, setPickerUnavailable] = useState<string | null>(null);
  const prefill = useRef<{ title: string; description: string } | null>(null);

  const form = useForm<CreateJobInput, unknown, CreateJob>({
    resolver: zodResolver(createJobSchema),
    defaultValues: { title: "", description: "", repoUrl: "", baseBranch: "main" },
  });

  const {
    control,
    register,
    handleSubmit,
    setError,
    setValue,
    getValues,
    formState: { errors, isSubmitting },
  } = form;

  const repoUrl = useWatch({ control, name: "repoUrl" });
  const shortcutHint = useSubmitShortcutHint();

  /** Clears every GitHub field at once, so a half-bound job can never be posted. */
  const clearBinding = useCallback(() => {
    setValue("githubInstallationId", undefined);
    setValue("repoOwner", undefined);
    setValue("repoName", undefined);
  }, [setValue]);

  const clearIssue = useCallback(() => {
    setValue("issueNumber", undefined);
    setValue("issueUrl", undefined);
  }, [setValue]);

  const onRepositoryChange = useCallback(
    (selection: RepositorySelection | null) => {
      if (!selection) {
        clearBinding();
        setValue("repoUrl", "");
        return;
      }
      setValue("githubInstallationId", selection.installationId);
      setValue("repoOwner", selection.owner);
      setValue("repoName", selection.name);
      setValue("repoUrl", selection.repoUrl);
      setValue("baseBranch", selection.defaultBranch);
    },
    [clearBinding, setValue],
  );

  const onIssueChange = useCallback(
    (selection: IssueSelection | null) => {
      if (!selection) {
        clearIssue();
        return;
      }

      setValue("issueNumber", selection.number);
      setValue("issueUrl", selection.url);

      // Prefill only what the person has not written themselves. An empty field
      // is fair game, and so is one still holding the previous issue's text;
      // anything else is their typing and stays.
      const current = getValues();
      const nextTitle = selection.title;
      const nextDescription = issueDescription(selection);
      if (current.title === "" || current.title === prefill.current?.title) {
        setValue("title", nextTitle, { shouldValidate: false });
      }
      if (current.description === "" || current.description === prefill.current?.description) {
        setValue("description", nextDescription, { shouldValidate: false });
      }
      prefill.current = { title: nextTitle, description: nextDescription };
    },
    [clearIssue, getValues, setValue],
  );

  const onUnavailable = useCallback(
    (reason: string) => {
      setPickerUnavailable(reason);
      setMode("manual");
      clearBinding();
      clearIssue();
    },
    [clearBinding, clearIssue],
  );

  const useManualUrl = () => {
    setMode("manual");
    clearBinding();
    clearIssue();
  };

  const usePicker = () => {
    setMode("picker");
    setValue("repoUrl", "");
  };

  const onSubmit = handleSubmit(async (values) => {
    let response: Response;
    try {
      response = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
    } catch {
      toast.error("Could not reach the server. Check your connection and try again.");
      return;
    }

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as ApiErrorBody | null;
      for (const [field, messages] of Object.entries(body?.fieldErrors ?? {})) {
        if (isFieldName(field) && messages[0]) {
          setError(field, { type: "server", message: messages[0] });
        }
      }
      toast.error(body?.error ?? "Could not create the job.");
      return;
    }

    const job = (await response.json()) as JobDetail;
    toast.success("Job created.");
    router.push(`/jobs/${job.id}`);
    router.refresh();
  });

  return (
    <form
      onSubmit={(event) => void onSubmit(event)}
      // The description is a textarea, so a plain Enter belongs to it. This is
      // the only key that can submit from inside the field somebody spends the
      // most time in.
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !isSubmitting) {
          event.preventDefault();
          void onSubmit(event);
        }
      }}
      noValidate
      className="space-y-6"
    >
      {/*
       * The picker used to sit in a bordered card while every other field was
       * bare, which gave one short form two visual grammars and made the
       * GitHub binding read like a widget bolted on rather than the first
       * three questions. It is the same stacked label-and-control as the rest
       * now; the heading is what separates the section.
       */}
      {githubEnabled && mode === "picker" ? (
        <section className="space-y-4">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-sm font-medium">GitHub</h2>
            <span className="text-muted-foreground text-xs">
              What lets this job end in a pull request.
            </span>
          </div>
          <RepositoryPicker
            onRepositoryChange={onRepositoryChange}
            onIssueChange={onIssueChange}
            onUnavailable={onUnavailable}
            disabled={isSubmitting}
          />
          <button
            type="button"
            onClick={useManualUrl}
            className="text-muted-foreground hover:text-foreground text-xs underline-offset-2 hover:underline"
          >
            Enter a repository URL instead
          </button>
          {errors.githubInstallationId?.message || errors.repoOwner?.message ? (
            <p className="text-destructive text-xs">
              {errors.githubInstallationId?.message ?? errors.repoOwner?.message}
            </p>
          ) : null}
        </section>
      ) : null}

      <Field
        label="Title"
        htmlFor="title"
        hint="A one-line summary of the change."
        error={errors.title?.message}
      >
        <Input
          id="title"
          placeholder="Add a health check endpoint"
          aria-invalid={errors.title ? true : undefined}
          {...register("title")}
        />
      </Field>

      <Field
        label="Description"
        htmlFor="description"
        hint="What Rivet should do, in as much detail as you would give a colleague."
        error={errors.description?.message}
      >
        <Textarea
          id="description"
          rows={8}
          placeholder="Return 200 with the build SHA at /api/health, and cover it with a test."
          aria-invalid={errors.description ? true : undefined}
          {...register("description")}
        />
      </Field>

      {/*
       * In picker mode the URL is derived, not entered. A read-only input said
       * "type here" about a value nothing can type into, and restated what the
       * repository select two fields up already shows. It is a line of text
       * with a hidden input behind it, because `repoUrl` is still what gets
       * posted.
       */}
      {mode === "picker" ? (
        <>
          <input type="hidden" {...register("repoUrl")} />
          <div className="grid gap-6 sm:grid-cols-[2fr_1fr]">
            <div className="space-y-2">
              <p className="text-sm font-medium">Repository URL</p>
              <p className="text-muted-foreground font-mono text-sm break-all">
                {repoUrl === "" ? "Pick a repository above." : repoUrl}
              </p>
              {errors.repoUrl?.message ? (
                <p className="text-destructive text-xs">{errors.repoUrl.message}</p>
              ) : null}
            </div>

            <Field
              label="Base branch"
              htmlFor="baseBranch"
              hint="Branched from here."
              error={errors.baseBranch?.message}
            >
              <Input
                id="baseBranch"
                placeholder="main"
                aria-invalid={errors.baseBranch ? true : undefined}
                {...register("baseBranch")}
              />
            </Field>
          </div>
        </>
      ) : (
        <div className="grid gap-6 sm:grid-cols-[2fr_1fr]">
          <Field
            label="Repository URL"
            htmlFor="repoUrl"
            hint="Must be https."
            error={errors.repoUrl?.message}
          >
            <Input
              id="repoUrl"
              inputMode="url"
              placeholder="https://github.com/acme/widgets"
              aria-invalid={errors.repoUrl ? true : undefined}
              {...register("repoUrl")}
            />
          </Field>

          <Field
            label="Base branch"
            htmlFor="baseBranch"
            hint="Branched from here."
            error={errors.baseBranch?.message}
          >
            <Input
              id="baseBranch"
              placeholder="main"
              aria-invalid={errors.baseBranch ? true : undefined}
              {...register("baseBranch")}
            />
          </Field>
        </div>
      )}

      {mode === "manual" ? (
        <p className="text-muted-foreground text-xs">
          {pickerUnavailable
            ? `${pickerUnavailable} This job runs against the URL above and finishes without opening a pull request.`
            : githubEnabled
              ? "This job runs against the URL above and finishes without opening a pull request."
              : "GitHub publication is off on this deployment, so a job ends at its validated diff."}
          {githubEnabled && !pickerUnavailable ? (
            <>
              {" "}
              <button
                type="button"
                onClick={usePicker}
                className="text-foreground underline-offset-2 hover:underline"
              >
                Pick a repository instead
              </button>
            </>
          ) : null}
        </p>
      ) : null}

      {/*
       * What submitting costs, before it is spent. These are the ceilings a
       * job gets when nothing names its own, and they are the honest thing to
       * state: nobody can promise what a run will take, but everybody can be
       * told where it stops.
       */}
      <div className="space-y-3 border-t pt-6">
        <p className="text-muted-foreground text-xs">
          A run stops at {formatDuration(JOB_BUDGET_DEFAULTS.maxDurationSeconds)} or{" "}
          {formatUsd(JOB_BUDGET_DEFAULTS.maxCostUsd)} of model spend, whichever it reaches first,
          and at {String(JOB_BUDGET_DEFAULTS.maxModelCalls)} model calls. You can cancel it from the
          job page at any point.
        </p>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          {/* `lg` is only one pixel taller here; the padding is what makes it
              read as the page's one expensive action. */}
          <Button type="submit" size="lg" disabled={isSubmitting} className="w-full px-6 sm:w-auto">
            {isSubmitting ? "Creating…" : "Create job"}
          </Button>
          <Button
            type="button"
            size="lg"
            variant="ghost"
            onClick={() => router.back()}
            className="w-full sm:w-auto"
          >
            Cancel
          </Button>
          {shortcutHint ? (
            <span className="text-muted-foreground hidden text-xs sm:inline">
              or press{" "}
              <kbd className="bg-code text-code-foreground rounded px-1.5 py-0.5 font-mono text-[11px]">
                {shortcutHint}
              </kbd>
            </span>
          ) : null}
        </div>
      </div>
    </form>
  );
}

/**
 * The submit shortcut, named the way this keyboard names it.
 *
 * Null until the effect runs, because the platform is a browser fact and this
 * component server-renders: printing "Ctrl" into the HTML and swapping it for
 * "⌘" after hydration is either a mismatch or a flicker, and showing nothing
 * for one frame is neither.
 */
function useSubmitShortcutHint(): string | null {
  const [hint, setHint] = useState<string | null>(null);

  useEffect(() => {
    const apple = /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
    setHint(apple ? "⌘ ↵" : "Ctrl ↵");
  }, []);

  return hint;
}

/**
 * The issue, as the task text a coding session reads.
 *
 * The issue URL is on the job and in the pull request body already; repeating
 * the number and title here is what makes the description standalone when
 * somebody edits it before submitting.
 */
function issueDescription(issue: IssueSelection): string {
  const heading = `Resolve issue #${String(issue.number)}: ${issue.title}`;
  const body = issue.body?.trim();
  return body ? `${heading}\n\n${body}` : heading;
}

function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string | undefined;
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
      {error ? <p className="text-destructive text-xs">{error}</p> : null}
    </div>
  );
}
