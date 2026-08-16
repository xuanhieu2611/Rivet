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
 * `secrets` is Milestone 9's addition and PRD §27's "secrets redaction from
 * logs". Every argument of every line passes through the registry before pino
 * formats it, so a short-lived installation token cannot reach a log file by
 * way of a message nobody expected to contain one. It costs a walk over the
 * arguments of each line and is skipped entirely when no secret is registered,
 * which is every run with `RIVET_GITHUB=off`.
 */
export function createLogger(level: LogLevel, workerId: string, secrets?: SecretRegistry): Logger {
  return pino({
    level,
    base: { workerId },
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
