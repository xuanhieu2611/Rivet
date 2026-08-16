CREATE TABLE "benchmark_cases" (
	"id" text PRIMARY KEY NOT NULL,
	"version_hash" text NOT NULL,
	"title" text NOT NULL,
	"category" text NOT NULL,
	"difficulty" integer NOT NULL,
	"base_commit_sha" text NOT NULL,
	"spec" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evaluation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"suite_id" uuid NOT NULL,
	"benchmark_id" text NOT NULL,
	"case_version_hash" text NOT NULL,
	"arm" text NOT NULL,
	"repetition" integer NOT NULL,
	"job_id" uuid,
	"result" text NOT NULL,
	"score" numeric(5, 4),
	"failure_category" text,
	"failure_label_source" text,
	"metrics_json" jsonb NOT NULL,
	"graded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evaluation_runs_suite_benchmark_arm_repetition_unique" UNIQUE("suite_id","benchmark_id","arm","repetition")
);
--> statement-breakpoint
CREATE TABLE "evaluation_suites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text NOT NULL,
	"arms" jsonb NOT NULL,
	"repetitions" integer DEFAULT 3 NOT NULL,
	"case_ids" jsonb NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "evaluation_runs" ADD CONSTRAINT "evaluation_runs_suite_id_evaluation_suites_id_fk" FOREIGN KEY ("suite_id") REFERENCES "public"."evaluation_suites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_runs" ADD CONSTRAINT "evaluation_runs_benchmark_id_benchmark_cases_id_fk" FOREIGN KEY ("benchmark_id") REFERENCES "public"."benchmark_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_runs" ADD CONSTRAINT "evaluation_runs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;