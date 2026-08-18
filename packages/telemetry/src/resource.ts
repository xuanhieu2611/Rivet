import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";

/**
 * What every span and every metric point from this process is stamped with.
 *
 * A resource is the part of telemetry that says *who is speaking*, and getting
 * it wrong is the failure that only shows up once there are two of something:
 * two workers whose spans are indistinguishable, or a staging collector whose
 * dashboards quietly include a laptop. So it is built by a pure function of an
 * options object, exported, and tested - rather than assembled inline in the
 * SDK wiring where nothing can assert on it.
 *
 * `RIVET_WORKER_ID` has no semantic convention, so it is `rivet.worker_id`
 * under Rivet's own namespace. Everything else uses the stable OTel attribute,
 * including `deployment.environment.name` - the milestone plan calls it
 * `deployment.environment`, which is the same attribute under the name it was
 * deprecated as. Emitting the stable one is what makes an off-the-shelf Grafana
 * dashboard work without a rename.
 */
export interface ResourceOptions {
  /** `rivet-web` or `rivet-worker`. One value per deployable, not per instance. */
  serviceName: string;
  serviceVersion: string;
  /** `development`, `test`, `production` - whatever `NODE_ENV` says. */
  environment: string;
  /**
   * The worker's per-process id, absent in the web app.
   *
   * The one attribute here that distinguishes two instances of the same
   * service, which is what makes "which worker ran this attempt" answerable
   * from a span alone rather than only from the job row.
   */
  workerId?: string;
}

/** The Rivet-namespaced worker attribute, exported so Stage 3 spans can reuse it. */
export const ATTR_RIVET_WORKER_ID = "rivet.worker_id";

export function resourceAttributes(options: ResourceOptions): Record<string, string> {
  return {
    [ATTR_SERVICE_NAME]: options.serviceName,
    [ATTR_SERVICE_VERSION]: options.serviceVersion,
    [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: options.environment,
    // Omitted rather than sent empty in the web app: an attribute present on
    // every resource with a blank value is worse than an absent one, because a
    // group-by silently gains a bucket that means "not applicable".
    ...(options.workerId === undefined ? {} : { [ATTR_RIVET_WORKER_ID]: options.workerId }),
  };
}
