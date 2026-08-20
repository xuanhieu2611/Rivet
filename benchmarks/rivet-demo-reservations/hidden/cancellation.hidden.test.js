import assert from "node:assert/strict";
import { test } from "node:test";

import { createReservationApp } from "../src/app.js";

const DUPLICATE_REFERENCES = [
  { id: "r-alice", customerId: "alice", reference: "SHARED-42", status: "confirmed" },
  { id: "r-bob", customerId: "bob", reference: "SHARED-42", status: "confirmed" },
];

test("duplicate references are scoped to the customer", () => {
  const app = createReservationApp(DUPLICATE_REFERENCES);

  const response = app.handleRequest({
    method: "POST",
    path: "/customers/bob/reservations/SHARED-42/cancel",
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.reservation.id, "r-bob");
  assert.deepEqual(app.store.snapshot(), [
    DUPLICATE_REFERENCES[0],
    { ...DUPLICATE_REFERENCES[1], status: "cancelled" },
  ]);
});

test("a reference owned only by another customer returns 404 without changing it", () => {
  const reservations = [
    { id: "r-alice", customerId: "alice", reference: "AL-ONLY", status: "confirmed" },
  ];
  const app = createReservationApp(reservations);

  const response = app.handleRequest({
    method: "POST",
    path: "/customers/bob/reservations/AL-ONLY/cancel",
  });

  assert.equal(response.status, 404);
  assert.deepEqual(app.store.snapshot(), reservations);
});

test("an already-cancelled duplicate does not hide the requesting customer's active reservation", () => {
  const app = createReservationApp([
    { ...DUPLICATE_REFERENCES[0], status: "cancelled" },
    DUPLICATE_REFERENCES[1],
  ]);

  const response = app.handleRequest({
    method: "POST",
    path: "/customers/bob/reservations/SHARED-42/cancel",
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.reservation.id, "r-bob");
});
