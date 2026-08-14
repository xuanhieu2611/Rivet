ALTER TABLE "jobs" ADD COLUMN "total_input_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "total_output_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "total_cost_usd" numeric(10, 4) DEFAULT '0' NOT NULL;