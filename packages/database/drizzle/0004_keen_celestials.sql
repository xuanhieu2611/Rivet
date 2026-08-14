CREATE TABLE "job_artifacts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"type" text NOT NULL,
	"phase" text NOT NULL,
	"content" text NOT NULL,
	"byte_size" integer NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "job_artifacts" ADD CONSTRAINT "job_artifacts_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_artifacts_job_id_id_idx" ON "job_artifacts" USING btree ("job_id","id");