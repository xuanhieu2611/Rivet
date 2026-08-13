import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

/**
 * Who this worker is, for the duration of this process.
 *
 * The value ends up in `jobs.lease_owner`, where it is a fencing token rather
 * than a label: every write a worker makes to a job it is running carries this
 * string, and the write is rejected if the row says someone else owns the job
 * now. So the one property that actually matters is that it is never reused.
 *
 * Host and pid alone are not enough. Pids are recycled, containers get the same
 * hostname across restarts, and a worker that crashes and comes back with the
 * same identity could fence itself past a reclaim that happened in between -
 * which is the exact split-brain the lease is supposed to prevent. The random
 * suffix is what makes each process genuinely new; the readable prefix is there
 * so a log line tells you which machine to go look at.
 */
export function createWorkerId(): string {
  return `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
}
