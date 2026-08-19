const BEATS = [
  {
    t: "00:00",
    title: "Hook",
    body: "A real bug in a repository the agent has not seen. The issue is an ordinary engineer writing: prevent concurrent double-booking.",
    still: "issue",
  },
  {
    t: "00:05",
    title: "Start",
    body: "One job. The worker claims it, provisions a sandbox, clones, records a baseline. A red baseline is not a failed job.",
    still: "provision",
  },
  {
    t: "00:10",
    title: "Investigate",
    body: "The planner is read-only. It can list, read, search and submit a plan. It cannot edit.",
    still: "timeline",
  },
  {
    t: "00:18",
    title: "Implement",
    body: "Edits land in the container. A lossless binary patch is checkpointed against the original commit, every turn.",
    still: null,
  },
  {
    t: "00:28",
    title: "Fail on purpose",
    body: "Targeted tests fail. Unhandled conflict error. The run revises. Autonomy that never misses is a commercial.",
    still: "failure",
  },
  {
    t: "00:36",
    title: "Validate",
    body: "Targeted tests, full suite, typecheck, lint. New failures are named. Pre-existing ones stay pre-existing.",
    still: null,
  },
  {
    t: "00:43",
    title: "Review",
    body: "A second agent, different tools. It cannot write. It can approve or request a revision. Rivet owns the loop bound.",
    still: null,
  },
  {
    t: "00:49",
    title: "Publish",
    body: "A branch, a commit, a pull request, once. Receipts in Postgres make the side effect idempotent.",
    still: "pull-request",
  },
  {
    t: "00:55",
    title: "Punchline",
    body: "The interesting part is not that an LLM wrote code. It is the job around it.",
    still: null,
  },
] as const;

type StillKind = NonNullable<(typeof BEATS)[number]["still"]>;

export function RunWalkthrough() {
  return (
    <div className="space-y-8">
      <ol className="space-y-0">
        {BEATS.map((beat) => (
          <li
            key={beat.t}
            className="landing-rule-t grid gap-4 py-6 md:grid-cols-[5.5rem_minmax(0,1fr)_minmax(0,16rem)] md:gap-8"
          >
            <p className="font-landing-mono text-landing-muted text-[12px] tabular-nums">
              {beat.t}
            </p>
            <div className="space-y-2">
              <h3 className="font-landing-display text-base font-semibold tracking-tight">
                {beat.title}
              </h3>
              <p className="text-[15px] leading-relaxed">{beat.body}</p>
            </div>
            {beat.still ? <Still kind={beat.still} /> : <div className="hidden md:block" />}
          </li>
        ))}
      </ol>
    </div>
  );
}

function Still({ kind }: { kind: StillKind }) {
  const label = {
    issue: "Issue",
    provision: "Provision",
    timeline: "Timeline",
    failure: "Validation",
    "pull-request": "Pull request",
  }[kind];

  return (
    <figure className="space-y-2">
      <div
        className="aspect-[16/10] w-full overflow-hidden"
        style={{ background: "var(--landing-still)", border: "1px solid var(--landing-rule)" }}
      >
        <svg viewBox="0 0 240 150" className="h-full w-full" aria-hidden="true">
          <rect width="240" height="18" fill="var(--landing-rule)" fillOpacity="0.35" />
          <circle cx="10" cy="9" r="2.2" fill="var(--landing-fail)" />
          <circle cx="18" cy="9" r="2.2" fill="var(--landing-rivet)" />
          <circle cx="26" cy="9" r="2.2" fill="var(--landing-pass)" />
          {kind === "issue" ? <IssueGlyph /> : null}
          {kind === "provision" ? <ProvisionGlyph /> : null}
          {kind === "timeline" ? <TimelineGlyph /> : null}
          {kind === "failure" ? <FailureGlyph /> : null}
          {kind === "pull-request" ? <PullRequestGlyph /> : null}
        </svg>
      </div>
      <figcaption className="font-landing-mono text-landing-muted text-[10px] tracking-wide uppercase">
        Still · {label} · capture pending
      </figcaption>
    </figure>
  );
}

function IssueGlyph() {
  return (
    <g fill="none" stroke="var(--landing-ink)" strokeWidth="1.2">
      <rect x="24" y="36" width="192" height="92" />
      <line x1="36" y1="52" x2="140" y2="52" />
      <line x1="36" y1="68" x2="196" y2="68" stroke="var(--landing-muted)" />
      <line x1="36" y1="80" x2="188" y2="80" stroke="var(--landing-muted)" />
      <line x1="36" y1="92" x2="160" y2="92" stroke="var(--landing-muted)" />
    </g>
  );
}

function ProvisionGlyph() {
  return (
    <g fontFamily="ui-monospace, monospace" fontSize="8" fill="var(--landing-ink)">
      <text x="28" y="52">
        provisioning sandbox
      </text>
      <text x="28" y="68">
        cloning repository
      </text>
      <text x="28" y="84">
        running baseline tests
      </text>
      <text x="28" y="104" fill="var(--landing-muted)">
        baseline: failed · continuing
      </text>
    </g>
  );
}

function TimelineGlyph() {
  return (
    <g fontFamily="ui-monospace, monospace" fontSize="8" fill="var(--landing-ink)">
      <text x="28" y="48">
        analyzing booking flow
      </text>
      <text x="28" y="64">
        search availability checks
      </text>
      <text x="28" y="80">
        inspect schema
      </text>
      <text x="28" y="104" fill="var(--landing-rivet)">
        plan.recorded
      </text>
    </g>
  );
}

function FailureGlyph() {
  return (
    <g fontFamily="ui-monospace, monospace" fontSize="8">
      <text x="28" y="52" fill="var(--landing-fail)">
        targeted tests: FAILED
      </text>
      <text x="28" y="72" fill="var(--landing-ink)">
        expected conflict
      </text>
      <text x="28" y="88" fill="var(--landing-muted)">
        received internal error
      </text>
      <text x="28" y="112" fill="var(--landing-pass)">
        revising implementation
      </text>
    </g>
  );
}

function PullRequestGlyph() {
  return (
    <g fontFamily="ui-monospace, monospace" fontSize="8" fill="var(--landing-ink)">
      <text x="28" y="56">
        Pull Request #184
      </text>
      <text x="28" y="76">
        Prevent concurrent
      </text>
      <text x="28" y="90">
        double-booking
      </text>
      <text x="28" y="114" fill="var(--landing-pass)">
        review approved
      </text>
    </g>
  );
}
