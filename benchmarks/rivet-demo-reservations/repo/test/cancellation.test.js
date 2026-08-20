import assert from "node:assert/strict";
import { test } from "node:test";

import { createReservationApp } from "../src/app.js";

const RESERVATIONS = [
  { id: "r-1", customerId: "alice", reference: "AL-104", status: "confirmed" },
  { id: "r-2", customerId: "bob", reference: "BO-205", status: "confirmed" },
];

test("cancels an existing reservation", () => {
  const app = createReservationApp(RESERVATIONS);

  const response = app.handleRequest({
    method: "POST",
    path: "/customers/alice/reservations/AL-104/cancel",
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.reservation.status, "cancelled");
});

test("returns 404 for an unknown reference", () => {
  const app = createReservationApp(RESERVATIONS);

  const response = app.handleRequest({
    method: "POST",
    path: "/customers/alice/reservations/MISSING/cancel",
  });

  assert.equal(response.status, 404);
});

test("returns 409 when the reservation is already cancelled", () => {
  const app = createReservationApp([{ ...RESERVATIONS[0], status: "cancelled" }]);

  const response = app.handleRequest({
    method: "POST",
    path: "/customers/alice/reservations/AL-104/cancel",
  });

  assert.equal(response.status, 409);
});
