"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import {
  type CreateJob,
  type CreateJobInput,
  createJobSchema,
  type JobDetail,
} from "@rivet/contracts";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { ApiErrorBody } from "@/lib/api/responses";

const FIELDS = ["title", "description", "repoUrl", "baseBranch"] as const;
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
 */
export function NewJobForm() {
  const router = useRouter();
  const form = useForm<CreateJobInput, unknown, CreateJob>({
    resolver: zodResolver(createJobSchema),
    defaultValues: { title: "", description: "", repoUrl: "", baseBranch: "main" },
  });

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = form;

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
