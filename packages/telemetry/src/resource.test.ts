import { describe, expect, it } from "vitest";

import { resourceAttributes } from "./resource";

describe("resourceAttributes", () => {
  it("stamps the worker's identity onto every span it will emit", () => {
    expect(
      resourceAttributes({
        serviceName: "rivet-worker",
        serviceVersion: "1.2.3",
        environment: "production",
        workerId: "worker-7",
      }),
    ).toEqual({
      "service.name": "rivet-worker",
      "service.version": "1.2.3",
      // The stable attribute. The milestone plan writes `deployment.environment`,
      // which is the deprecated spelling of this same one; the stable name is
      // what an off-the-shelf dashboard groups by.
      "deployment.environment.name": "production",
      "rivet.worker_id": "worker-7",
    });
  });

  it("omits the worker id entirely in the web app", () => {
    // Not an empty string: an attribute present on every resource with a blank
    // value adds a group-by bucket that means "not applicable".
    expect(
      resourceAttributes({
        serviceName: "rivet-web",
        serviceVersion: "1.2.3",
        environment: "development",
      }),
    ).not.toHaveProperty("rivet.worker_id");
  });
});
