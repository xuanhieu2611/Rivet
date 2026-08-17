import assert from "node:assert/strict";
import { test } from "node:test";

import { handleRequest } from "../src/server.js";

test("the final page contains only the remaining item", () => {
  const response = handleRequest("/widgets?page=3&limit=2");

  assert.equal(response.status, 200);
  assert.deepEqual(
    response.body.items.map(({ id }) => id),
    ["echo"],
  );
  assert.equal(response.body.page, 3);
  assert.equal(response.body.limit, 2);
  assert.equal(response.body.totalPages, 3);
  assert.equal(response.body.hasNext, false);
});

test("a page beyond the end is empty but valid", () => {
  const response = handleRequest("/widgets?page=4&limit=2");

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.items, []);
  assert.equal(response.body.hasNext, false);
});

test("invalid pagination values receive a bad request", () => {
  for (const query of ["?page=0", "?page=-1", "?page=1.5", "?limit=0", "?limit=4", "?limit=two"]) {
    assert.equal(handleRequest(`/widgets${query}`).status, 400, query);
  }
});
