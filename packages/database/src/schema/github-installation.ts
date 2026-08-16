import { boolean, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * GitHub App installations Rivet can use for repository discovery and
 * publication. The primary key is GitHub's installation id, not a Rivet
 * surrogate, so callbacks and API responses can address the row directly.
 */
export const githubInstallations = pgTable("github_installations", {
  id: integer("id").primaryKey(),
  accountLogin: text("account_login").notNull(),
  accountType: text("account_type").notNull(),
  targetType: text("target_type").notNull(),
  permissions: jsonb("permissions").$type<Record<string, string>>().notNull(),
  suspended: boolean("suspended").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type GithubInstallation = typeof githubInstallations.$inferSelect;
export type NewGithubInstallation = typeof githubInstallations.$inferInsert;
