import assert from "node:assert/strict";
import { test } from "node:test";

import { handleRequest } from "../src/server.js";

test("the widget endpoint returns the default first page", () => {
  const response = handleRequest("/widgets");

  assert.equal(response.status, 200);
  assert.deepEqual(
    response.body.items.map(({ id }) => id),
    ["alpha", "bravo"],
  );
  assert.deepEqual(response.body, {
    items: response.body.items,
    page: 1,
    limit: 2,
    totalItems: 5,
    totalPages: 3,
    hasNext: true,
  });
});

test("the first explicit page preserves order", () => {
  const response = handleRequest("/widgets?page=1&limit=3");

  assert.equal(response.status, 200);
  assert.deepEqual(
    response.body.items.map(({ id }) => id),
    ["alpha", "bravo", "charlie"],
  );
  assert.equal(response.body.limit, 3);
});
