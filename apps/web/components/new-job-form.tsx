"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import {
  type CreateJob,
  type CreateJobInput,
  createJobSchema,
  type JobDetail,
} from "@rivet/contracts";
import { useRouter } from "next/navigation";
import { useCallback, useRef, useState } from "react";
import { useForm } from "react-hook-form";
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
    register,
    handleSubmit,
    setError,
    setValue,
    getValues,
    formState: { errors, isSubmitting },
  } = form;

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
    <form onSubmit={(event) => void onSubmit(event)} noValidate className="space-y-6">
      {githubEnabled && mode === "picker" ? (
        <div className="border-border/70 space-y-4 rounded-xl border p-4">
          <div className="space-y-1">
            <h2 className="text-sm font-medium">GitHub</h2>
            <p className="text-muted-foreground text-xs">
              A picked repository is what lets this job end in a pull request.
            </p>
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
        </div>
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

      <div className="grid gap-6 sm:grid-cols-[2fr_1fr]">
        <Field
          label="Repository URL"
          htmlFor="repoUrl"
          hint={mode === "picker" ? "Filled by the picker." : "Must be https."}
          error={errors.repoUrl?.message}
        >
          <Input
            id="repoUrl"
            inputMode="url"
            placeholder="https://github.com/acme/widgets"
            readOnly={mode === "picker"}
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

      <div className="flex items-center gap-3 pt-2">
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Creating…" : "Create job"}
        </Button>
        <Button type="button" variant="ghost" onClick={() => router.back()}>
          Cancel
        </Button>
      </div>
    </form>
  );
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
