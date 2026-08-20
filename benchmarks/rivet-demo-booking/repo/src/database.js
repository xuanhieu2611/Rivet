import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const initialMigration = readFileSync(
  new URL("../migrations/001_initial.sql", import.meta.url),
  "utf8",
);

export function createBookingDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec(initialMigration);
  return database;
}
