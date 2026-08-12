CREATE TYPE "public"."job_status" AS ENUM('queued', 'provisioning', 'analyzing', 'planning', 'implementing', 'testing', 'reviewing', 'revising', 'finalizing', 'completed', 'failed', 'cancelled', 'budget_exceeded', 'timed_out');--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"repo_url" text NOT NULL,
	"base_branch" text DEFAULT 'main' NOT NULL,
	"base_commit_sha" text,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"max_duration_seconds" integer DEFAULT 3600 NOT NULL,
	"max_cost_usd" numeric(10, 2) DEFAULT '5.00' NOT NULL,
	"max_model_calls" integer DEFAULT 200 NOT NULL,
	"max_tool_calls" integer DEFAULT 500 NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"final_branch" text,
	"pull_request_url" text,
	"failure_reason" text
);
--> statement-breakpoint
CREATE INDEX "jobs_status_created_at_idx" ON "jobs" USING btree ("status","created_at" DESC NULLS LAST);