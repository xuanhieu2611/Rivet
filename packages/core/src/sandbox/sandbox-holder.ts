import type { Sandbox } from "./sandbox";

/**
 * The one place a run's live sandbox is remembered.
 *
 * It exists because of who has to destroy a container versus who creates one.
 * The `provisioning` phase creates it, but the phase is exactly the thing that
 * might never return - the processor abandons a hung phase promise rather than
 * waiting for it - so cleanup cannot live inside the phase. The processor owns
 * the holder and destroys whatever is in it from a `finally` block, and the
 * phase's only obligation is to put the handle here the instant it exists.
 *
 * A holder rather than a plain variable so that the reference is shared: the
 * processor hands the same object to the pipeline and keeps a way to read it
 * back, without the pipeline having to return anything.
 */
export class SandboxHolder {
  private sandbox: Sandbox | undefined;

  /** What the run currently owns, if anything. */
  get current(): Sandbox | undefined {
    return this.sandbox;
  }

  /** Called immediately after `create()` resolves, before anything else can fail. */
  set(sandbox: Sandbox): void {
    this.sandbox = sandbox;
  }

  /**
   * The sandbox, or an error naming the phase that assumed one existed.
   *
   * A phase execing before provisioning ran is a bug in the pipeline's order,
   * not a runtime condition, so it fails loudly rather than creating a second
   * container nobody asked for.
   */
  require(): Sandbox {
    if (!this.sandbox) {
      throw new Error("No sandbox has been created for this run yet.");
    }
    return this.sandbox;
  }

  /**
   * Destroys and forgets the sandbox. Idempotent, and never throws.
   *
   * Returns the id of what it destroyed, or `undefined` when there was nothing
   * to destroy - which is what lets the caller decide whether a
   * `sandbox.destroyed` event is worth writing. The handle is cleared before
   * the await so a second concurrent call cannot destroy the same container
   * twice.
   */
  async destroy(): Promise<string | undefined> {
    const sandbox = this.sandbox;
    if (!sandbox) return undefined;
    this.sandbox = undefined;

    // `Sandbox.destroy` is documented as never throwing. This catch is here
    // because "documented" and "true of every future implementation" are
    // different things, and a cleanup error that escapes a `finally` block
    // replaces the failure that actually mattered.
    await sandbox.destroy().catch(() => undefined);
    return sandbox.id;
  }
}
