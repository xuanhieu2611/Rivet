const PROPERTIES = [
  {
    title: "It survives a crash",
    body: "Kill the worker mid-job with kill -9. Another worker claims the job, rebuilds the sandbox from the last checkpoint, verifies its SHA-256, and carries on. A checkpoint that fails verification stops the job; Rivet never quietly starts over.",
  },
  {
    title: "It contains the AI",
    body: "The model's API key never enters the container running the cloned code. Each agent gets an exact set of tools, so the planner and the reviewer cannot write a byte, and Rivet verifies that set in code before every session.",
  },
  {
    title: "It tells the truth about tests",
    body: "Every check runs before and after the change. A test failure the change introduced fails the job, even in a suite that was already red; failures that were already there are reported as pre-existing.",
  },
  {
    title: "It acts on GitHub exactly once",
    body: "Pushes and pull requests write a receipt to Postgres before the job moves on. A retry, a reclaim or a second worker reads the receipt instead of repeating the action.",
  },
  {
    title: "You can watch it think",
    body: "Every phase, command, model call and GitHub request is an OpenTelemetry span, and the browser streams the job's append-only event log live. Budgets cap model calls, tokens, cost and wall-clock time per job.",
  },
  {
    title: "It measures itself",
    body: "An evaluation harness runs benchmark tasks as ordinary jobs, then grades each result in a second container against hidden tests the agent never saw.",
  },
] as const;

const STACK = [
  { area: "Interface", items: "Next.js 16, React 19, server-sent events" },
  { area: "Orchestration", items: "Node.js worker, PostgreSQL with Drizzle, Redis with BullMQ" },
  { area: "Execution", items: "Docker sandboxes, the Pi agent harness, models via OpenRouter" },
  { area: "Integration", items: "A GitHub App with short-lived installation tokens" },
  { area: "Operations", items: "OpenTelemetry, Grafana, Tempo, Prometheus" },
  { area: "Quality", items: "TypeScript (strict), Vitest, 1,400+ tests, CI on every push" },
] as const;

export function EngineeringProperties() {
  return (
    <dl className="border-rule grid border-t sm:grid-cols-2 lg:grid-cols-3">
      {PROPERTIES.map((property) => (
        <div key={property.title} className="border-rule border-b py-8 sm:pr-10">
          <dt className="type-heading text-xl">{property.title}</dt>
          <dd className="text-muted mt-3 text-[0.9875rem] leading-relaxed">{property.body}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Stack() {
  return (
    <dl className="grid gap-x-10 gap-y-5 sm:grid-cols-2 lg:grid-cols-3">
      {STACK.map((row) => (
        <div key={row.area}>
          <dt className="text-faint text-sm">{row.area}</dt>
          <dd className="mt-1 text-[0.9875rem] leading-relaxed">{row.items}</dd>
        </div>
      ))}
    </dl>
  );
}
