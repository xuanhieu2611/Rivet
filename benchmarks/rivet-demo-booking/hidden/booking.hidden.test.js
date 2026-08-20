import assert from "node:assert/strict";
import { test } from "node:test";

import { createBookingApp } from "../src/app.js";

const FIRST = {
  roomId: "atlas",
  guestName: "Ada",
  startsAt: "2026-05-04T09:00:00.000Z",
  endsAt: "2026-05-04T10:00:00.000Z",
};

test("two concurrent overlapping requests store exactly one booking", async (t) => {
  const app = createBookingApp({ hooks: { afterAvailabilityCheck: rendezvous(2) } });
  t.after(() => app.close());

  const [first, second] = await Promise.all([
    app.handleRequest({ method: "POST", path: "/bookings", body: FIRST }),
    app.handleRequest({
      method: "POST",
      path: "/bookings",
      body: {
        ...FIRST,
        guestName: "Grace",
        startsAt: "2026-05-04T09:30:00.000Z",
        endsAt: "2026-05-04T10:30:00.000Z",
      },
    }),
  ]);

  assert.deepEqual([first.status, second.status].sort(), [201, 409]);
  assert.equal(count(app.database, "bookings"), 1);
  assert.equal(count(app.database, "booking_slots"), 2);
});

test("concurrent requests for different rooms both succeed", async (t) => {
  const app = createBookingApp({ hooks: { afterAvailabilityCheck: rendezvous(2) } });
  t.after(() => app.close());

  const results = await Promise.all([
    app.handleRequest({ method: "POST", path: "/bookings", body: FIRST }),
    app.handleRequest({
      method: "POST",
      path: "/bookings",
      body: { ...FIRST, roomId: "borealis", guestName: "Grace" },
    }),
  ]);

  assert.deepEqual(
    results.map(({ status }) => status),
    [201, 201],
  );
  assert.equal(count(app.database, "bookings"), 2);
});

test("the database rejects duplicate room slots", async (t) => {
  const app = createBookingApp();
  t.after(() => app.close());

  const booking = app.repository.createBooking(FIRST, [FIRST.startsAt]);
  const insert = app.database.prepare(
    "INSERT INTO booking_slots (booking_id, room_id, starts_at) VALUES (?, ?, ?)",
  );

  assert.throws(() => insert.run(booking.id, FIRST.roomId, FIRST.startsAt), /constraint|unique/i);
});

test("a slot conflict rolls back the whole booking write", async (t) => {
  const app = createBookingApp();
  t.after(() => app.close());

  app.repository.createBooking(FIRST, ["2026-05-04T09:30:00.000Z"]);
  const beforeBookings = count(app.database, "bookings");
  const beforeSlots = count(app.database, "booking_slots");

  assert.throws(
    () =>
      app.repository.createBooking(
        {
          ...FIRST,
          guestName: "Grace",
          startsAt: "2026-05-04T09:00:00.000Z",
          endsAt: "2026-05-04T10:00:00.000Z",
        },
        ["2026-05-04T09:00:00.000Z", "2026-05-04T09:30:00.000Z"],
      ),
    /constraint|unique/i,
  );

  assert.equal(count(app.database, "bookings"), beforeBookings);
  assert.equal(count(app.database, "booking_slots"), beforeSlots);
});

function count(database, table) {
  return database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
}

function rendezvous(parties) {
  let arrivals = 0;
  let release;
  const ready = new Promise((resolve) => {
    release = resolve;
  });

  return async () => {
    arrivals += 1;
    if (arrivals === parties) release();
    await ready;
  };
}
