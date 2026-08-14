"use client";

import { jobStatusSchema } from "@rivet/contracts";
import type { SyntheticEvent } from "react";

import { Button } from "@/components/ui/button";
import { formatCommandDuration, formatTimeOfDay } from "@/lib/format";
import { statusLabel } from "@/lib/job-status";

import { useJobLive } from "./job-live-provider";
import type { LiveCommand } from "./stream-state";

/** Live command metadata with lazy, bounded transcript details. */
export function LiveCommandLog() {
  const { commands } = useJobLive();

  if (commands.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">No sandbox commands have been recorded yet.</p>
    );
  }

  return (
    <div className="space-y-2" aria-live="polite" aria-relevant="additions text">
      {commands.map((command) => (
        <LiveCommandRow key={command.key} command={command} />
      ))}
    </div>
  );
}

function LiveCommandRow({ command }: { command: LiveCommand }) {
  const { requestCommandDetails, retryCommandDetails } = useJobLive();
  const commandId = command.commandId;
  const recordedCommand = command.detail ?? command.summary;
  const canLoadTranscript = commandId !== null && command.status !== "running";

  function handleToggle(event: SyntheticEvent<HTMLDetailsElement>) {
    if (event.currentTarget.open && canLoadTranscript && commandId !== null) {
      requestCommandDetails(commandId);
    }
  }

  return (
    <details
      className="group rounded-lg border bg-muted/20"
      onToggle={handleToggle}
      data-command-id={commandId === null ? undefined : String(commandId)}
      data-command-status={command.status}
    >
      <summary className="flex cursor-pointer list-none items-start gap-4 p-3 [&::-webkit-details-marker]:hidden">
        <div className="min-w-0 flex-1">
          <code className="block font-mono text-xs break-all" title={formatArgv(command.argv)}>
            {formatArgv(command.argv)}
          </code>
          <div className="text-muted-foreground mt-1 flex flex-wrap gap-x-2 gap-y-1 text-xs">
            <span>{formatPhase(command.phase)}</span>
            <span aria-hidden>·</span>
            <span className="break-all" title={command.cwd}>
              {command.cwd || "unknown cwd"}
            </span>
            <span aria-hidden>·</span>
            <time dateTime={command.createdAt.toISOString()}>
              {formatTimeOfDay(command.createdAt)}
            </time>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3 text-xs">
          <span className={outcomeClassName(command)}>{outcomeLabel(command)}</span>
          <span className="text-muted-foreground font-mono">{durationLabel(command)}</span>
          <span
            aria-hidden
            className="text-muted-foreground transition-transform group-open:rotate-180"
          >
            ▾
          </span>
        </div>
      </summary>
      <div className="border-t px-3 pt-3 pb-3">
        <div className="text-muted-foreground mb-2 flex flex-wrap gap-2 text-xs">
          {commandId !== null ? <span>Command #{String(commandId)}</span> : null}
          {command.executionId ? (
            <span className="font-mono">Execution {command.executionId}</span>
          ) : null}
          {recordedCommand?.truncated ? <span>Output truncated</span> : null}
          {recordedCommand?.oomKilled ? <span>OOM killed</span> : null}
          {recordedCommand?.timedOut ? <span>Timed out</span> : null}
        </div>

        {command.status === "running" ? (
          <p className="text-muted-foreground text-xs">Command is running…</p>
        ) : command.status === "failed" ? (
          <p className="text-destructive text-sm">{command.error ?? "Command execution failed."}</p>
        ) : command.detail ? (
          <Transcript command={command.detail} />
        ) : command.detailState.status === "loading" ? (
          <p className="text-muted-foreground text-xs">Loading transcript…</p>
        ) : command.detailState.status === "error" ? (
          <div className="space-y-2">
            <p className="text-destructive text-xs">
              {command.detailState.error ?? "Could not load transcript."}
            </p>
            {commandId === null ? null : (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => retryCommandDetails(commandId)}
              >
                Retry transcript
              </Button>
            )}
          </div>
        ) : (
          <p className="text-muted-foreground text-xs">Open this command to load its transcript.</p>
        )}
      </div>
    </details>
  );
}

function Transcript({ command }: { command: NonNullable<LiveCommand["detail"]> }) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <TranscriptSection label="stdout" value={command.stdout} />
      <TranscriptSection label="stderr" value={command.stderr} />
    </div>
  );
}

function TranscriptSection({ label, value }: { label: string; value: string }) {
  return (
    <section className="min-w-0 space-y-1">
      <h3 className="text-muted-foreground font-mono text-xs">{label}</h3>
      <pre className="max-h-96 overflow-auto rounded-md bg-background p-3 font-mono text-xs whitespace-pre-wrap break-words">
        {value || "(empty)"}
      </pre>
    </section>
  );
}

function formatArgv(argv: readonly string[]): string {
  return argv.map((argument) => JSON.stringify(argument)).join(" ") || "(empty command)";
}

function formatPhase(phase: string): string {
  const parsed = jobStatusSchema.safeParse(phase);
  return parsed.success ? statusLabel(parsed.data) : phase;
}

function durationLabel(command: LiveCommand): string {
  return command.durationMs === null ? "-" : formatCommandDuration(command.durationMs);
}

function outcomeLabel(command: LiveCommand): string {
  if (command.status === "running") return "Running";
  if (command.status === "failed") return "Failed";
  if (command.detail?.oomKilled || command.summary?.oomKilled) return "OOM killed";
  if (command.detail?.timedOut || command.summary?.timedOut) return "Timed out";
  if (command.exitCode === null) return "Killed";
  return `Exit ${String(command.exitCode)}`;
}

function outcomeClassName(command: LiveCommand): string {
  if (
    command.status === "failed" ||
    command.detail?.oomKilled ||
    command.summary?.oomKilled ||
    command.detail?.timedOut ||
    command.summary?.timedOut ||
    (command.status !== "running" && command.exitCode === null)
  ) {
    return "text-destructive";
  }
  if (command.status === "running") return "text-sky-600 dark:text-sky-400";
  return command.exitCode === 0
    ? "text-emerald-600 dark:text-emerald-400"
    : "text-amber-600 dark:text-amber-400";
}
