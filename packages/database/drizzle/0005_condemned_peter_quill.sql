CREATE TABLE "job_checkpoints" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"attempt_count" integer NOT NULL,
	"kind" text NOT NULL,
	"completed_phase" text,
	"resume_phase" text NOT NULL,
	"agent_turn" integer,
	"base_commit_sha" text NOT NULL,
	"sandbox_id" text NOT NULL,
	"env_fingerprint" jsonb NOT NULL,
	"state_json" jsonb NOT NULL,
	"patch_format" text NOT NULL,
	"patch_compression" text NOT NULL,
	"patch_sha256" text NOT NULL,
	"patch_byte_size" integer NOT NULL,
	"patch_compressed_bytes" integer NOT NULL,
	"patch_payload" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_checkpoints_job_id_sequence_unique" UNIQUE("job_id","sequence")
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "total_model_calls" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "total_tool_calls" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "total_turns" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "dispatch_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "deadline_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "job_checkpoints" ADD CONSTRAINT "job_checkpoints_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_checkpoints_job_id_sequence_idx" ON "job_checkpoints" USING btree ("job_id","sequence" DESC NULLS LAST);