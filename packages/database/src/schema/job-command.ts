import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { jobs } from "./job";

/**
 * Every command a job ran inside its sandbox, with its transcript.
 *
 * Append-only, like `job_events`, and for the same reason: this is evidence that
 * a run happened, and evidence that can be edited is not evidence. Nothing
 * updates a row.
 *
 * It is a table of its own rather than a `job_events` payload because the event
 * log is read in full on every timeline render and is meant to hold small facts.
 * A `pnpm install` transcript is neither small nor a fact. The timeline keeps a
 * command lifecycle carrying `argv`, `exitCode`, `durationMs` and the id of the
 * row below on `command.completed`; the transcript is fetched only when someone
 * opens it.
 *
 * Milestone 4's `tool_calls` sits next to this and has the same shape, which is
 * the other reason to get it right now.
 */
export const jobCommands = pgTable(
  "job_commands",
  {
    /** Globally monotonic, same reasoning as `job_events.id`, and the list cursor. */
    id: bigserial("id", { mode: "number" }).primaryKey(),

    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),

    /**
     * The `JobStatus` the job was in when the command ran.
     *
     * Text rather than the `job_status` pgEnum: this records what a phase did,
     * it is never joined or filtered as a state machine, and a phase renamed in
     * a later milestone should not invalidate the history of runs that used the
     * old name.
     */
    phase: text("phase").notNull(),

    /**
     * The argument vector, as `string[]`.
     *
     * jsonb rather than a joined shell string on purpose - the sandbox never
     * runs anything through a shell, so there is no quoting layer that could
     * disagree with what actually executed.
     */
    argv: jsonb("argv").$type<string[]>().notNull(),
    cwd: text("cwd").notNull(),

    /** Null when the command was killed before it could exit: timeout, abort, or OOM. */
    exitCode: integer("exit_code"),
    durationMs: integer("duration_ms").notNull(),

    /** Capped head+tail, with the elided byte count stated inline. Never null; a silent command wrote "". */
    stdout: text("stdout").notNull().default(""),
    stderr: text("stderr").notNull().default(""),

    /** True when the cap was hit, so a reader knows the gap in the middle is ours. */
    truncated: boolean("truncated").notNull().default(false),
    /** The command outlived its own timeout, distinct from the job outliving `max_duration_seconds`. */
    timedOut: boolean("timed_out").notNull().default(false),
    /** Read off `State.OOMKilled`, which is what tells a memory kill apart from every other 137. */
    oomKilled: boolean("oom_killed").notNull().default(false),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // The only read pattern: one job's commands in order, optionally after a cursor.
  (table) => [index("job_commands_job_id_id_idx").on(table.jobId, table.id)],
);

export type JobCommandRow = typeof jobCommands.$inferSelect;
export type NewJobCommandRow = typeof jobCommands.$inferInsert;
