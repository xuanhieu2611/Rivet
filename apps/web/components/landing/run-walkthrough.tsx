const BEATS = [
  {
    t: "00:00",
    title: "Hook",
    body: "A real bug in a repository the agent has not seen. The issue is an ordinary engineer writing: prevent concurrent double-booking.",
    still: {
      src: "/landing/run/issue.png",
      alt: "GitHub issue describing the concurrent room double-booking bug",
      caption: "Seeded GitHub issue #1",
    },
  },
  {
    t: "00:05",
    title: "Start",
    body: "One job. The worker claims it, provisions a sandbox, clones, records a baseline. A red baseline is not a failed job.",
    still: null,
  },
  {
    t: "00:10",
    title: "Investigate",
    body: "The planner is read-only. It can list, read, search and submit a plan. It cannot edit.",
    still: null,
  },
  {
    t: "00:18",
    title: "Implement",
    body: "Edits land in the container. A lossless binary patch is checkpointed against the original commit, every turn.",
    still: null,
  },
  {
    t: "00:28",
    title: "First attempt rejected",
    body: "The planner's first structured submission exceeds Rivet's schema bounds. Rivet rejects it; the planner shortens the fields and submits a valid plan on the next turn.",
    still: {
      src: "/landing/run/timeline.png",
      alt: "Rivet timeline showing a rejected submit plan tool call followed by a corrected submission",
      caption: "Real schema rejection and recovery",
    },
  },
  {
    t: "00:36",
    title: "Validate",
    body: "Targeted tests, full suite, typecheck, lint. New failures are named. Pre-existing ones stay pre-existing.",
    still: {
      src: "/landing/run/validation.png",
      alt: "Rivet validation cards showing verified tests, typecheck and lint",
      caption: "Real validation and review",
    },
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
    still: {
      src: "/landing/run/pull-request.png",
      alt: "GitHub pull request opened by Rivet for the booking fix",
      caption: "Pull request #3",
    },
  },
  {
    t: "00:55",
    title: "Punchline",
    body: "The interesting part is not that an LLM wrote code. It is the job around it.",
    still: null,
  },
] as const;

export function RunWalkthrough() {
  return (
    <ol>
      {BEATS.map((beat) => (
        <li
          key={beat.t}
          className="landing-rule-t grid gap-4 py-7 md:grid-cols-[5.5rem_minmax(0,1fr)_minmax(0,15rem)] md:gap-10"
        >
          <p className="font-landing-mono text-landing-muted text-sm tabular-nums">{beat.t}</p>
          <div className="space-y-2">
            <h3 className="text-lg font-semibold tracking-tight">{beat.title}</h3>
            <p className="text-base leading-relaxed">{beat.body}</p>
          </div>
          {beat.still ? <Still {...beat.still} /> : <div className="hidden md:block" />}
        </li>
      ))}
    </ol>
  );
}

function Still({ src, alt, caption }: { src: string; alt: string; caption: string }) {
  return (
    <figure className="space-y-2">
      <div className="aspect-[16/10] overflow-hidden rounded-[var(--radius)] border border-[var(--landing-rule)] bg-[var(--landing-still)]">
        <img src={src} alt={alt} width={1280} height={800} className="h-full w-full object-cover" />
      </div>
      <figcaption className="text-landing-muted text-xs">{caption}</figcaption>
    </figure>
  );
}
