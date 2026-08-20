import assert from "node:assert/strict";
import { test } from "node:test";

import { createBookingApp } from "../src/app.js";

const MORNING = {
  roomId: "atlas",
  guestName: "Ada",
  startsAt: "2026-05-04T09:00:00.000Z",
  endsAt: "2026-05-04T10:00:00.000Z",
};

test("creates a booking", async (t) => {
  const app = createBookingApp();
  t.after(() => app.close());

  const result = await app.handleRequest({ method: "POST", path: "/bookings", body: MORNING });

  assert.equal(result.status, 201);
  assert.equal(result.body.booking.roomId, "atlas");
});

test("allows adjacent bookings", async (t) => {
  const app = createBookingApp();
  t.after(() => app.close());

  assert.equal(
    (await app.handleRequest({ method: "POST", path: "/bookings", body: MORNING })).status,
    201,
  );
  assert.equal(
    (
      await app.handleRequest({
        method: "POST",
        path: "/bookings",
        body: {
          ...MORNING,
          guestName: "Grace",
          startsAt: MORNING.endsAt,
          endsAt: "2026-05-04T11:00:00.000Z",
        },
      })
    ).status,
    201,
  );
});

test("rejects a sequential overlapping booking", async (t) => {
  const app = createBookingApp();
  t.after(() => app.close());

  await app.handleRequest({ method: "POST", path: "/bookings", body: MORNING });
  const conflict = await app.handleRequest({
    method: "POST",
    path: "/bookings",
    body: { ...MORNING, guestName: "Lin", startsAt: "2026-05-04T09:30:00.000Z" },
  });

  assert.equal(conflict.status, 409);
});
