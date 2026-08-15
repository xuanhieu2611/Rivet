ALTER TABLE "jobs" ADD COLUMN "review_mode" text DEFAULT 'independent' NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "max_review_loops" integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "review_loops" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "review_decision" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "review_blocking_count" integer;