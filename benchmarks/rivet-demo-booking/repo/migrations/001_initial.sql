PRAGMA foreign_keys = ON;

CREATE TABLE bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL,
  guest_name TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL
);

CREATE TABLE booking_slots (
  booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  room_id TEXT NOT NULL,
  starts_at TEXT NOT NULL
);
