import { traceFields } from "@rivet/core";
import { pino, type Logger } from "pino";

import type { LogLevel } from "./config";
import type { SecretRegistry } from "./secrets";

export type { Logger };

/**
 * Structured logs, because the worker is the part of Rivet nobody watches.
 *
 * The web app has a UI; a failing job has a timeline. The worker has this. Every
 * line carries `jobId` and `workerId` via child loggers, so "what happened to
 * job X" is one filter rather than a grep through interleaved output from a
 * process running several jobs at once - which is precisely what concurrency
 * makes unreadable in a `console.log` codebase.
 *
 * Pretty-printing is on only for a TTY, so an interactive `pnpm dev` is
 * readable and anything piped to a file or a log collector stays JSON.
 *
 * `traceContext` is Milestone 11's addition and the whole of "logs join the
 * trace rather than being replaced by it". Every line grows `trace_id` and
 * `span_id` from whatever span is active when it is written, which is what
 * makes a Grafana trace and a log line two views of one event rather than two
 * systems that happen to run at once.
 *
 * It arrives as a supplier rather than as a `Telemetry` because of an ordering
 * problem that is real rather than theoretical: the logger is built before the
 * telemetry handle exists, since `createWorkerTelemetry` needs a logger to
 * report its export failures to. A closure over a variable assigned immediately
 * afterwards resolves that without either one pretending to be optional.
 *
 * `secrets` is Milestone 9's addition and PRD §27's "secrets redaction from
 * logs". Every argument of every line passes through the registry before pino
 * formats it, so a short-lived installation token cannot reach a log file by
 * way of a message nobody expected to contain one. It costs a walk over the
 * arguments of each line and is skipped entirely when no secret is registered,
 * which is every run with `RIVET_GITHUB=off`.
 */
export function createLogger(
  level: LogLevel,
  workerId: string,
  secrets?: SecretRegistry,
  traceContext?: () => string | undefined,
): Logger {
  return pino({
    level,
    base: { workerId },
    // Absent when telemetry is off, when no span is active, or when the active
    // context is not sampled. An absent pair leaves the line exactly as it was:
    // `trace_id: ""` on every line of a system whose default is telemetry off
    // would put an empty bucket in every group-by that ever reads one.
    ...(traceContext ? { mixin: () => traceFields(traceContext()) ?? {} } : {}),
    ...(secrets
      ? {
          hooks: {
            logMethod(args, method) {
              // The common case is no live secret at all, and paying for a
              // deep walk per line to find that out would be silly.
              if (secrets.size === 0) return method.apply(this, args);
              return method.apply(this, args.map((arg) => secrets.redactDeep(arg)) as typeof args);
            },
          },
        }
      : {}),
    ...(process.stdout.isTTY
      ? {
          transport: {
            target: "pino-pretty",
            options: { colorize: true, translateTime: "HH:MM:ss.l", ignore: "pid,hostname" },
          },
        }
      : {}),
  });
}
