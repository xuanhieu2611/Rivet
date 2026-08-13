import { pino, type Logger } from "pino";

import type { LogLevel } from "./config";

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
 */
export function createLogger(level: LogLevel, workerId: string): Logger {
  return pino({
    level,
    base: { workerId },
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
