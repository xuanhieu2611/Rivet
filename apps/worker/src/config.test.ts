import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertArtifactReadLimits,
  assertLeaseInvariant,
  DEFAULT_BENCHMARK_FIXTURE_ROOT,
  DEFAULT_BENCHMARK_ROOT,
  DEFAULT_MODEL,
  DEFAULT_MODEL_PROVIDER,
  DEFAULT_OTLP_ENDPOINT,
  DEFAULT_SANDBOX_IMAGE,
  DEFAULT_SANDBOX_WORKDIR,
  parseWorkerConfig as parse,
  WORKER_SERVICE_NAME,
  WorkerConfigError,
} from "./config";

/**
 * A model key, because `RIVET_AGENT` defaults to `pi` and `pi` without a key
 * refuses to boot.
 *
 * Supplied by default here so that every case about leases, sandboxes and
 * faults keeps saying what it was written to say instead of also being a test
 * about credentials. The cases that *are* about the key call `parse` directly.
 */
const KEYED = { OPENROUTER_API_KEY: "sk-test-not-a-real-key" };

function parseWorkerConfig(env: Record<string, string | undefined> = {}) {
  return parse({ ...KEYED, ...env });
}

describe("parseWorkerConfig", () => {
  it("applies every default for an empty environment", () => {
    expect(parseWorkerConfig({})).toEqual({
      concurrency: 2,
      leaseSeconds: 30,
      heartbeatSeconds: 10,
      sweepIntervalMs: 60_000,
      maxAttempts: 3,
      pipelineSpeed: 1,
      reviewMode: "independent",
      maxReviewLoops: 2,
      artifactMaxBytes: 262_144,
      checkpointMaxBytes: 4_194_304,
      checkpointTimeoutMs: 30_000,
      shutdownGraceMs: 15_000,
      logLevel: "info",
      sandbox: {
        mode: "docker",
        image: DEFAULT_SANDBOX_IMAGE,
        workdir: DEFAULT_SANDBOX_WORKDIR,
        memoryBytes: 2_048 * 1_024 * 1_024,
        nanoCpus: 2_000_000_000,
        pidsLimit: 512,
        commandTimeoutMs: 120_000,
        cloneTimeoutMs: 180_000,
        installTimeoutMs: 300_000,
        baselineTimeoutMs: 300_000,
        checkTimeoutMs: 180_000,
        maxOutputBytes: 65_536,
        // Above `artifactMaxBytes` on purpose: a diff clipped by the container's
        // transcript cap would record its clipped length as its true size.
        diffMaxBytes: 1_048_576,
        validationReportMaxBytes: 4_194_304,
        targetedMaxFiles: 25,
        reapGraceMs: 120_000,
      },
      agent: {
        mode: "pi",
        model: DEFAULT_MODEL,
        provider: DEFAULT_MODEL_PROVIDER,
        sessionTimeoutMs: 900_000,
        maxTurns: 40,
        toolOutputMaxBytes: 32_768,
        fileMaxBytes: 262_144,
        previewMaxBytes: 2_048,
        homeDir: join(tmpdir(), "rivet-pi"),
      },
      github: {
        // Off by default, unlike the sandbox and the agent, because publishing
        // needs an App that a fresh machine has not registered yet. Production
        // refuses this value, which is where the default stops being benign.
        mode: "off",
        cloneTimeoutMs: 180_000,
        pushTimeoutMs: 180_000,
        seedMaxBytes: 268_435_456,
      },
      eval: {
        // Off by default and refused in production: the evaluation harness is
        // the one switch that widens what a worker will clone.
        mode: "off",
        benchmarkRoot: DEFAULT_BENCHMARK_ROOT,
        fixtureRoot: DEFAULT_BENCHMARK_FIXTURE_ROOT,
        cloneTimeoutMs: 180_000,
        seedMaxBytes: 268_435_456,
        concurrency: 1,
      },
      telemetry: {
        // Off by default like GitHub and the harness, and unlike them, legal in
        // production: a worker with telemetry off is degraded rather than
        // dishonest.
        mode: "off",
        endpoint: DEFAULT_OTLP_ENDPOINT,
        exportIntervalMs: 15_000,
        exportTimeoutMs: 10_000,
        serviceName: WORKER_SERVICE_NAME,
        serviceVersion: "0.0.0-dev",
        environment: "development",
      },
    });
  });

  it("defaults to a real sandbox, so simulation is always a decision", () => {
    // The Milestone 1 pipeline is still in the codebase and still works. It is
    // reachable only by asking for it, because a default that happens to be
    // fake is the kind of thing that survives into a deployment.
    expect(parseWorkerConfig({}).sandbox.mode).toBe("docker");
  });

  it("pins the image by digest as well as by tag", () => {
    // A tag is what a human reads; the digest is what stops an upstream retag
    // silently changing what a job runs.
    expect(DEFAULT_SANDBOX_IMAGE).toContain("@sha256:");
  });

  it("converts the sandbox limits into the units Docker wants", () => {
    const config = parseWorkerConfig({
      SANDBOX_MEMORY_MB: "512",
      // Fractional on purpose: half a core is a reasonable ask and NanoCpus is
      // an integer.
      SANDBOX_CPUS: "0.5",
      SANDBOX_PIDS_LIMIT: "64",
    });

    expect(config.sandbox.memoryBytes).toBe(536_870_912);
    expect(config.sandbox.nanoCpus).toBe(500_000_000);
    expect(config.sandbox.pidsLimit).toBe(64);
  });

  it("gives clone, install, test, and other checks their own budgets", () => {
    // Different kinds of slow. A cold install and a four-minute test
    // suite are both normal; reporting either as `command_timed_out` would
    // blame the sandbox for a property of the repository.
    const config = parseWorkerConfig({
      SANDBOX_COMMAND_TIMEOUT_MS: "1000",
      SANDBOX_CLONE_TIMEOUT_MS: "2000",
      SANDBOX_INSTALL_TIMEOUT_MS: "3000",
      SANDBOX_BASELINE_TIMEOUT_MS: "4000",
      SANDBOX_CHECK_TIMEOUT_MS: "5000",
    });

    expect(config.sandbox.commandTimeoutMs).toBe(1_000);
    expect(config.sandbox.cloneTimeoutMs).toBe(2_000);
    expect(config.sandbox.installTimeoutMs).toBe(3_000);
    expect(config.sandbox.baselineTimeoutMs).toBe(4_000);
    expect(config.sandbox.checkTimeoutMs).toBe(5_000);
  });

  it("reads the validation report and targeted selection limits", () => {
    const config = parseWorkerConfig({
      RIVET_VALIDATION_REPORT_MAX_BYTES: "2097152",
      RIVET_TARGETED_MAX_FILES: "40",
    });

    expect(config.sandbox.validationReportMaxBytes).toBe(2_097_152);
    expect(config.sandbox.targetedMaxFiles).toBe(40);
  });

  it("bounds every new validation setting", () => {
    expect(() => parseWorkerConfig({ SANDBOX_CHECK_TIMEOUT_MS: "999" })).toThrow(WorkerConfigError);
    expect(() => parseWorkerConfig({ RIVET_VALIDATION_REPORT_MAX_BYTES: "16777217" })).toThrow(
      WorkerConfigError,
    );
    expect(() => parseWorkerConfig({ RIVET_TARGETED_MAX_FILES: "0" })).toThrow(WorkerConfigError);
    expect(() => parseWorkerConfig({ RIVET_TARGETED_MAX_FILES: "201" })).toThrow(WorkerConfigError);
  });

  it("requires complete diff and reporter reads to exceed the artifact cap", () => {
    expect(() => parseWorkerConfig({ RIVET_ARTIFACT_MAX_BYTES: "1048576" })).toThrow(
      /RIVET_DIFF_MAX_BYTES/,
    );
    expect(() =>
      parseWorkerConfig({
        RIVET_ARTIFACT_MAX_BYTES: "4194304",
        RIVET_DIFF_MAX_BYTES: "8388608",
      }),
    ).toThrow(/RIVET_VALIDATION_REPORT_MAX_BYTES/);
  });

  it("refuses a workdir that is not absolute", () => {
    // It is passed straight to `mkdir -p` and to every `cwd` in the run.
    expect(() => parseWorkerConfig({ SANDBOX_WORKDIR: "workspace" })).toThrow(WorkerConfigError);
  });

  it("refuses to simulate the pipeline in production", () => {
    // A worker that completes every job in twenty-one seconds without doing
    // anything looks entirely healthy, which is the worst failure mode
    // available. Refusing to boot is the cheap version of that conversation.
    expect(() => parseWorkerConfig({ RIVET_SANDBOX: "off", NODE_ENV: "production" })).toThrow(
      WorkerConfigError,
    );
    expect(() => parseWorkerConfig({ RIVET_SANDBOX: "off", NODE_ENV: "production" })).toThrow(
      /RIVET_SANDBOX=off/,
    );
  });

  it("allows the simulated pipeline everywhere else", () => {
    // Including with no NODE_ENV at all, which is how the integration suite and
    // a laptop with no daemon run.
    expect(parseWorkerConfig({ RIVET_SANDBOX: "off" }).sandbox.mode).toBe("off");
    expect(parseWorkerConfig({ RIVET_SANDBOX: "off", NODE_ENV: "test" }).sandbox.mode).toBe("off");
  });

  it("rejects a sandbox mode that is not one of the two", () => {
    expect(() => parseWorkerConfig({ RIVET_SANDBOX: "podman" })).toThrow(WorkerConfigError);
  });

  it("reads values from the environment", () => {
    const config = parseWorkerConfig({
      WORKER_CONCURRENCY: "4",
      WORKER_LEASE_SECONDS: "60",
      WORKER_HEARTBEAT_SECONDS: "5",
      RIVET_PIPELINE_SPEED: "0",
      RIVET_REVIEW_MODE: "none",
      RIVET_MAX_REVIEW_LOOPS: "5",
      LOG_LEVEL: "debug",
    });

    expect(config.concurrency).toBe(4);
    expect(config.leaseSeconds).toBe(60);
    expect(config.heartbeatSeconds).toBe(5);
    expect(config.pipelineSpeed).toBe(0);
    expect(config.reviewMode).toBe("none");
    expect(config.maxReviewLoops).toBe(5);
    expect(config.logLevel).toBe("debug");
  });

  it("bounds the review defaults", () => {
    expect(() => parseWorkerConfig({ RIVET_REVIEW_MODE: "off" })).toThrow(WorkerConfigError);
    expect(() => parseWorkerConfig({ RIVET_MAX_REVIEW_LOOPS: "-1" })).toThrow(WorkerConfigError);
    expect(() => parseWorkerConfig({ RIVET_MAX_REVIEW_LOOPS: "6" })).toThrow(WorkerConfigError);
    expect(() => parseWorkerConfig({ RIVET_MAX_REVIEW_LOOPS: "1.5" })).toThrow(WorkerConfigError);
  });

  it("treats an empty string as unset rather than as zero", () => {
    // A `.env` file with blank placeholders is normal, and Zod's coercion would
    // otherwise read `WORKER_CONCURRENCY=""` as a concurrency of 0.
    expect(parseWorkerConfig({ WORKER_CONCURRENCY: "", LOG_LEVEL: "" }).concurrency).toBe(2);
  });

  it("rejects a heartbeat that cannot keep the lease alive", () => {
    // The invariant this whole file exists for. A 15s heartbeat against a 30s
    // lease means one missed beat is survivable and two are not, so the sweeper
    // would reclaim jobs from a worker that is doing nothing wrong.
    expect(() =>
      parseWorkerConfig({ WORKER_HEARTBEAT_SECONDS: "15", WORKER_LEASE_SECONDS: "30" }),
    ).toThrow(WorkerConfigError);

    expect(() =>
      parseWorkerConfig({ WORKER_HEARTBEAT_SECONDS: "90", WORKER_LEASE_SECONDS: "30" }),
    ).toThrow(/must be at most/);
  });

  it("accepts a heartbeat exactly at the limit", () => {
    const config = parseWorkerConfig({
      WORKER_HEARTBEAT_SECONDS: "10",
      WORKER_LEASE_SECONDS: "30",
    });
    expect(config.heartbeatSeconds * 3).toBe(config.leaseSeconds);
  });

  it("rejects values that are not numbers", () => {
    expect(() => parseWorkerConfig({ WORKER_CONCURRENCY: "lots" })).toThrow(WorkerConfigError);
  });

  it("rejects a fractional or non-positive concurrency", () => {
    expect(() => parseWorkerConfig({ WORKER_CONCURRENCY: "2.5" })).toThrow(WorkerConfigError);
    expect(() => parseWorkerConfig({ WORKER_CONCURRENCY: "0" })).toThrow(WorkerConfigError);
    expect(() => parseWorkerConfig({ WORKER_CONCURRENCY: "-1" })).toThrow(WorkerConfigError);
  });

  it("reads the sweeper's knobs", () => {
    const config = parseWorkerConfig({
      WORKER_SWEEP_INTERVAL_MS: "5000",
      WORKER_MAX_ATTEMPTS: "5",
    });

    expect(config.sweepIntervalMs).toBe(5_000);
    expect(config.maxAttempts).toBe(5);
  });

  it("reads every fault mode when both halves are set", () => {
    for (const mode of ["throw", "fatal", "hang", "exit", "no-daemon", "oom", "slow-command"]) {
      const config = parseWorkerConfig({ RIVET_FAULT_PHASE: "testing", RIVET_FAULT_MODE: mode });
      expect(config.fault).toEqual({ phase: "testing", mode });
    }
  });

  it("leaves the fault absent when neither half is set", () => {
    expect(parseWorkerConfig({}).fault).toBeUndefined();
    // Blank placeholders in a `.env` file are the normal way this arrives.
    expect(
      parseWorkerConfig({ RIVET_FAULT_PHASE: "", RIVET_FAULT_MODE: "" }).fault,
    ).toBeUndefined();
  });

  it("rejects a half-configured fault", () => {
    // Both single-variable mistakes are silent otherwise: a mode with no phase
    // would break an unpredictable phase, and a phase with no mode would look
    // armed while doing nothing.
    expect(() => parseWorkerConfig({ RIVET_FAULT_PHASE: "testing" })).toThrow(WorkerConfigError);
    expect(() => parseWorkerConfig({ RIVET_FAULT_MODE: "fatal" })).toThrow(/must be set together/);
  });

  it("rejects an unknown fault mode", () => {
    expect(() =>
      parseWorkerConfig({ RIVET_FAULT_PHASE: "testing", RIVET_FAULT_MODE: "explode" }),
    ).toThrow(WorkerConfigError);
  });

  it("rejects an unknown log level", () => {
    expect(() => parseWorkerConfig({ LOG_LEVEL: "chatty" })).toThrow(WorkerConfigError);
  });

  it("reports every problem at once, not one per restart", () => {
    try {
      parseWorkerConfig({ WORKER_CONCURRENCY: "nope", LOG_LEVEL: "chatty" });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkerConfigError);
      expect((error as WorkerConfigError).problems).toHaveLength(2);
    }
  });
});

describe("the coding agent", () => {
  it("defaults to a real agent, so a simulated implementing phase is a decision", () => {
    // The same rule as the sandbox, for the phase that is the entire point of
    // the system: a default that happens to be fake is what survives into a
    // deployment and completes every job without writing any code.
    expect(parseWorkerConfig().agent.mode).toBe("pi");
  });

  it("refuses to boot with an agent and no key", () => {
    // Discovering this on the first job, after a container and a clone have
    // already been paid for, is a slow way to learn something a startup check
    // answers instantly - and it burns an attempt doing it.
    expect(() => parse({})).toThrow(WorkerConfigError);
    expect(() => parse({})).toThrow(/needs OPENROUTER_API_KEY/);
  });

  it("needs no key when there is no agent to run", () => {
    expect(parse({ RIVET_AGENT: "off" }).agent.mode).toBe("off");
  });

  it("does not demand an OpenRouter key for a provider that is not OpenRouter", () => {
    // A different provider is a different variable, and belongs to whoever
    // adds one rather than to a check that would refuse a valid configuration.
    expect(() => parse({ RIVET_MODEL_PROVIDER: "anthropic" })).not.toThrow();
  });

  it("refuses to simulate the implementing phase in production", () => {
    expect(() => parse({ RIVET_AGENT: "off", NODE_ENV: "production" })).toThrow(
      /without writing any code/,
    );
  });

  it("takes the model, its provider and every ceiling from the environment", () => {
    const config = parseWorkerConfig({
      RIVET_MODEL: "anthropic/claude-sonnet-5",
      RIVET_MODEL_PROVIDER: "anthropic",
      AGENT_SESSION_TIMEOUT_MS: "60000",
      AGENT_MAX_TURNS: "5",
      AGENT_TOOL_OUTPUT_MAX_BYTES: "2048",
      AGENT_FILE_MAX_BYTES: "4096",
      AGENT_PREVIEW_MAX_BYTES: "256",
      AGENT_HOME_DIR: "/var/lib/rivet/pi",
    });

    expect(config.agent).toEqual({
      mode: "pi",
      model: "anthropic/claude-sonnet-5",
      provider: "anthropic",
      sessionTimeoutMs: 60_000,
      maxTurns: 5,
      toolOutputMaxBytes: 2_048,
      fileMaxBytes: 4_096,
      previewMaxBytes: 256,
      homeDir: "/var/lib/rivet/pi",
    });
  });

  it("rejects an agent mode that is not one of the three", () => {
    expect(() => parseWorkerConfig({ RIVET_AGENT: "claude" })).toThrow(WorkerConfigError);
  });

  it("takes the script path for a scripted agent, and needs no key", () => {
    const config = parse({ RIVET_AGENT: "scripted", RIVET_AGENT_SCRIPT: "./src/demo-agent.ts" });

    expect(config.agent.mode).toBe("scripted");
    expect(config.agent.scriptPath).toBe("./src/demo-agent.ts");
  });

  it("refuses a scripted agent with no script to run", () => {
    // Both halves or neither, exactly like the fault variables: a scripted mode
    // with no module is a worker that says it has an agent and has none.
    expect(() => parse({ RIVET_AGENT: "scripted" })).toThrow(/needs RIVET_AGENT_SCRIPT/);
  });

  it("refuses a script that would be silently ignored", () => {
    // The expensive direction of the same mistake: this configuration looks
    // canned and would quietly call the real provider on every job.
    expect(() => parseWorkerConfig({ RIVET_AGENT_SCRIPT: "./src/demo-agent.ts" })).toThrow(
      /RIVET_AGENT is pi/,
    );
  });

  it("refuses a scripted agent in production", () => {
    expect(() =>
      parse({
        RIVET_AGENT: "scripted",
        RIVET_AGENT_SCRIPT: "./src/demo-agent.ts",
        NODE_ENV: "production",
      }),
    ).toThrow(/rather than what a model decided/);
  });
});

describe("GitHub publication", () => {
  const PEM = "-----BEGIN RSA PRIVATE KEY-----\nnot-a-real-key\n-----END RSA PRIVATE KEY-----\n";
  const APP = {
    RIVET_GITHUB: "app",
    GITHUB_APP_ID: "123456",
    GITHUB_APP_PRIVATE_KEY: Buffer.from(PEM, "utf8").toString("base64"),
  };

  it("is off by default, so publication is always a decision", () => {
    expect(parseWorkerConfig().github.mode).toBe("off");
  });

  it("refuses to skip publication in production", () => {
    // The third of the three, and the one that hides best: every phase runs for
    // real and the job still completes without producing a pull request.
    expect(() => parseWorkerConfig({ RIVET_GITHUB: "off", NODE_ENV: "production" })).toThrow(
      /without opening a pull request/,
    );
  });

  it("decodes the base64 private key into a PEM", () => {
    const config = parseWorkerConfig(APP);

    expect(config.github.mode).toBe("app");
    expect(config.github.appId).toBe("123456");
    expect(config.github.privateKey).toBe(PEM);
  });

  it("names every missing credential at once", () => {
    // Checked at startup rather than at publication: `finalizing` is the last
    // phase, so the alternative discovers this after a container, a clone, an
    // install, a model session and a review have all been paid for.
    expect(() => parseWorkerConfig({ RIVET_GITHUB: "app" })).toThrow(
      /GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY/,
    );
  });

  it("refuses a private key that is not base64-encoded PEM text", () => {
    // The failure this prevents is a signature error on the first API call,
    // which reads as an App misconfiguration rather than as a mangled variable.
    expect(() => parseWorkerConfig({ ...APP, GITHUB_APP_PRIVATE_KEY: PEM })).toThrow(
      /did not decode to a PEM private key/,
    );
  });

  it("ignores credentials while GitHub is off", () => {
    // Not an error, unlike RIVET_AGENT_SCRIPT: one `.env.local` serves a machine
    // that switches between publishing and not, and the web app reads the same
    // two variables for its own pickers.
    const config = parseWorkerConfig({ ...APP, RIVET_GITHUB: "off" });

    expect(config.github.appId).toBeUndefined();
    expect(config.github.privateKey).toBeUndefined();
  });

  it("gives the host clone and push their own budgets and bound", () => {
    // Distinct from SANDBOX_CLONE_TIMEOUT_MS: different operations, on
    // different machines, with different reasons to be slow.
    const config = parseWorkerConfig({
      ...APP,
      GITHUB_CLONE_TIMEOUT_MS: "60000",
      GITHUB_PUSH_TIMEOUT_MS: "90000",
      GITHUB_SEED_MAX_BYTES: "2097152",
    });

    expect(config.github.cloneTimeoutMs).toBe(60_000);
    expect(config.github.pushTimeoutMs).toBe(90_000);
    expect(config.github.seedMaxBytes).toBe(2_097_152);
  });

  it("keeps the run link base absolute, without a trailing slash", () => {
    // The base is concatenated with `/jobs/<id>`, so a trailing slash would
    // produce a double slash in every published pull request body.
    expect(
      parseWorkerConfig({ RIVET_APP_URL: "https://rivet.example.com/" }).github.appBaseUrl,
    ).toBe("https://rivet.example.com");
    expect(parseWorkerConfig().github.appBaseUrl).toBeUndefined();
  });

  it("rejects a run link base that is not a URL", () => {
    // A relative value here would silently produce pull request links that
    // resolve against github.com.
    expect(() => parseWorkerConfig({ RIVET_APP_URL: "/jobs" })).toThrow(WorkerConfigError);
  });
});

describe("evaluation harness", () => {
  /** A production environment the other three switches already accept. */
  const PRODUCTION = {
    NODE_ENV: "production",
    RIVET_GITHUB: "app",
    GITHUB_APP_ID: "123456",
    GITHUB_APP_PRIVATE_KEY: Buffer.from(
      "-----BEGIN RSA PRIVATE KEY-----\nnot-a-real-key\n-----END RSA PRIVATE KEY-----\n",
      "utf8",
    ).toString("base64"),
  };

  it("is off by default, so a worker never looks for benchmarks it was not asked for", () => {
    const config = parseWorkerConfig();

    expect(config.eval.mode).toBe("off");
    expect(config.eval.benchmarkRoot).toBe(DEFAULT_BENCHMARK_ROOT);
    expect(config.eval.fixtureRoot).toBe(DEFAULT_BENCHMARK_FIXTURE_ROOT);
  });

  it("refuses to run benchmark fixtures in production", () => {
    // The fourth member of the switch family, and the only one whose refusal is
    // about widening rather than narrowing: `on` teaches this worker to clone
    // something other than the repository a job named. The rest of the
    // environment is a valid production one, so this is the only complaint.
    const production = { ...PRODUCTION, RIVET_EVAL: "on" };

    expect(() => parseWorkerConfig(production)).toThrow(/widens what this worker will run against/);
    expect(() => parseWorkerConfig(production)).toThrow(WorkerConfigError);
    expect(() => parseWorkerConfig(PRODUCTION)).not.toThrow();
  });

  it("allows the harness outside production", () => {
    // Including with no NODE_ENV at all, which is how CI and a laptop run.
    expect(parseWorkerConfig({ RIVET_EVAL: "on" }).eval.mode).toBe("on");
    expect(parseWorkerConfig({ RIVET_EVAL: "on", NODE_ENV: "test" }).eval.mode).toBe("on");
  });

  it("takes both roots and both host bounds from the environment", () => {
    const config = parseWorkerConfig({
      RIVET_EVAL: "on",
      RIVET_BENCHMARK_ROOT: "/srv/benchmarks",
      RIVET_BENCHMARK_FIXTURE_ROOT: "/srv/built",
      RIVET_EVAL_CLONE_TIMEOUT_MS: "60000",
      RIVET_EVAL_SEED_MAX_BYTES: "2097152",
      RIVET_EVAL_CONCURRENCY: "4",
    });

    expect(config.eval.benchmarkRoot).toBe("/srv/benchmarks");
    expect(config.eval.fixtureRoot).toBe("/srv/built");
    expect(config.eval.cloneTimeoutMs).toBe(60_000);
    expect(config.eval.seedMaxBytes).toBe(2_097_152);
    expect(config.eval.concurrency).toBe(4);
  });

  it("rejects a mode that is neither on nor off", () => {
    expect(() => parseWorkerConfig({ RIVET_EVAL: "yes" })).toThrow(WorkerConfigError);
  });
});

describe("telemetry", () => {
  /** A production environment every other switch already accepts. */
  const PRODUCTION = {
    NODE_ENV: "production",
    RIVET_GITHUB: "app",
    GITHUB_APP_ID: "123456",
    GITHUB_APP_PRIVATE_KEY: Buffer.from(
      "-----BEGIN RSA PRIVATE KEY-----\nnot-a-real-key\n-----END RSA PRIVATE KEY-----\n",
      "utf8",
    ).toString("base64"),
  };

  it("is the one switch whose off is legal in production", () => {
    // The other four refuse because a worker that skips real work looks
    // healthy while lying about it. This one skips only the ability to watch,
    // and refusing to boot over that would take a deployment down to protect
    // its dashboards.
    expect(() => parseWorkerConfig(PRODUCTION)).not.toThrow();
    expect(parseWorkerConfig({ ...PRODUCTION, RIVET_TELEMETRY: "off" }).telemetry.mode).toBe("off");
    expect(parseWorkerConfig({ ...PRODUCTION, RIVET_TELEMETRY: "otlp" }).telemetry.mode).toBe(
      "otlp",
    );
  });

  it("reads the standard OTLP endpoint variable and strips its trailing slash", () => {
    const config = parseWorkerConfig({
      RIVET_TELEMETRY: "otlp",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318/",
      RIVET_TELEMETRY_EXPORT_INTERVAL_MS: "5000",
      RIVET_TELEMETRY_EXPORT_TIMEOUT_MS: "2000",
      RIVET_SERVICE_VERSION: "abc1234",
      NODE_ENV: "test",
    });

    expect(config.telemetry).toEqual({
      mode: "otlp",
      endpoint: "http://collector:4318",
      exportIntervalMs: 5_000,
      exportTimeoutMs: 2_000,
      serviceName: WORKER_SERVICE_NAME,
      serviceVersion: "abc1234",
      environment: "test",
    });
  });

  it("refuses an endpoint that is not an absolute URL", () => {
    // Caught here rather than at the first export, which happens on a
    // background timer where nobody is looking.
    expect(() =>
      parseWorkerConfig({ RIVET_TELEMETRY: "otlp", OTEL_EXPORTER_OTLP_ENDPOINT: "localhost:4318" }),
    ).toThrow(WorkerConfigError);
  });

  it("rejects a mode that is neither otlp nor off", () => {
    expect(() => parseWorkerConfig({ RIVET_TELEMETRY: "on" })).toThrow(WorkerConfigError);
  });
});

describe("assertLeaseInvariant", () => {
  it("accepts the defaults", () => {
    expect(() => assertLeaseInvariant(10, 30)).not.toThrow();
  });

  it("accepts a heartbeat with room to spare", () => {
    expect(() => assertLeaseInvariant(2, 30)).not.toThrow();
  });

  it("rejects anything that leaves fewer than three heartbeats of slack", () => {
    expect(() => assertLeaseInvariant(11, 30)).toThrow(WorkerConfigError);
  });
});

describe("assertArtifactReadLimits", () => {
  it("accepts both complete-read caps above the artifact cap", () => {
    expect(() => assertArtifactReadLimits(1_024, 2_048, 4_096)).not.toThrow();
  });

  it("reports both invalid relationships together", () => {
    try {
      assertArtifactReadLimits(4_096, 4_096, 2_048);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkerConfigError);
      expect((error as WorkerConfigError).problems).toHaveLength(2);
    }
  });
});
