import type { JobCommand } from "@rivet/contracts";

import { formatCommandDuration, formatTimeOfDay } from "@/lib/format";
import { statusLabel } from "@/lib/job-status";

/**
 * Server-rendered command history for a job's sandbox.
 *
 * The list is intentionally separate from the timeline. The timeline stays a
 * small event log, while each command can disclose its bounded transcript on
 * demand without adding a client component or another polling loop.
 */
export function CommandList({ commands }: { commands: readonly JobCommand[] }) {
  if (commands.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">No sandbox commands have been recorded yet.</p>
    );
  }

  return (
    <div className="space-y-2">
      {commands.map((command) => {
        const argv = formatArgv(command.argv);
        return (
          <details key={command.id} className="group rounded-lg border bg-muted/20">
            <summary className="flex cursor-pointer list-none items-start gap-4 p-3 [&::-webkit-details-marker]:hidden">
              <div className="min-w-0 flex-1">
                <code className="block truncate font-mono text-xs" title={argv}>
                  {argv}
                </code>
                <div className="text-muted-foreground mt-1 flex flex-wrap gap-x-2 gap-y-1 text-xs">
                  <span>{statusLabel(command.phase)}</span>
                  <span aria-hidden>·</span>
                  <span className="truncate" title={command.cwd}>
                    {command.cwd}
                  </span>
                  <span aria-hidden>·</span>
                  <time dateTime={command.createdAt.toISOString()}>
                    {formatTimeOfDay(command.createdAt)}
                  </time>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-3 text-xs">
                <span className={outcomeClassName(command)}>{outcomeLabel(command)}</span>
                <span className="text-muted-foreground font-mono">
                  {formatCommandDuration(command.durationMs)}
                </span>
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
                <span>Command #{String(command.id)}</span>
                {command.truncated ? <span>Output truncated</span> : null}
                {command.oomKilled ? <span>OOM killed</span> : null}
                {command.timedOut ? <span>Timed out</span> : null}
              </div>
              <pre className="max-h-96 overflow-auto rounded-md bg-background p-3 font-mono text-xs whitespace-pre-wrap break-words">
                {renderTranscript(command)}
              </pre>
            </div>
          </details>
        );
      })}
    </div>
  );
}

function formatArgv(argv: readonly string[]): string {
  return argv.map((argument) => JSON.stringify(argument)).join(" ");
}

function outcomeLabel(command: JobCommand): string {
  if (command.oomKilled) return "OOM killed";
  if (command.timedOut) return "Timed out";
  if (command.exitCode === null) return "Killed";
  return `Exit ${String(command.exitCode)}`;
}

function outcomeClassName(command: JobCommand): string {
  if (command.oomKilled || command.timedOut || command.exitCode === null) {
    return "text-destructive";
  }
  return command.exitCode === 0
    ? "text-emerald-600 dark:text-emerald-400"
    : "text-amber-600 dark:text-amber-400";
}

function renderTranscript(command: JobCommand): string {
  return ["stdout", command.stdout || "(empty)", "", "stderr", command.stderr || "(empty)"].join(
    "\n",
  );
}
