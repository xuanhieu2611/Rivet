CREATE TABLE "job_external_effects" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"external_url" text NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_external_effects_job_id_kind_unique" UNIQUE("job_id","kind")
);
--> statement-breakpoint
CREATE TABLE "github_installations" (
	"id" integer PRIMARY KEY NOT NULL,
	"account_login" text NOT NULL,
	"account_type" text NOT NULL,
	"target_type" text NOT NULL,
	"permissions" jsonb NOT NULL,
	"suspended" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "github_installation_id" integer;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "repo_owner" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "repo_name" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "issue_number" integer;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "issue_url" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "pull_request_number" integer;--> statement-breakpoint
ALTER TABLE "job_external_effects" ADD CONSTRAINT "job_external_effects_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_external_effects_job_id_id_idx" ON "job_external_effects" USING btree ("job_id","id");