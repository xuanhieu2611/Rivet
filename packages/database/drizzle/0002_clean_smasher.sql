CREATE TABLE "job_commands" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"phase" text NOT NULL,
	"argv" jsonb NOT NULL,
	"cwd" text NOT NULL,
	"exit_code" integer,
	"duration_ms" integer NOT NULL,
	"stdout" text DEFAULT '' NOT NULL,
	"stderr" text DEFAULT '' NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"timed_out" boolean DEFAULT false NOT NULL,
	"oom_killed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "sandbox_id" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "env_fingerprint" jsonb;--> statement-breakpoint
ALTER TABLE "job_commands" ADD CONSTRAINT "job_commands_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_commands_job_id_id_idx" ON "job_commands" USING btree ("job_id","id");