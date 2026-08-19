const TOPICS = [
  {
    title: "Why jobs instead of chat",
    body: "A chat transcript is a conversation. A job is a durable state machine with a lease, a budget, a deadline and an append-only event log. If the worker dies, the job does not.",
  },
  {
    title: "Why sandboxing",
    body: "The model runs in the worker. Its tools run in a disposable container that never sees the model key, never sees Postgres, never sees Redis. That is a capability boundary, not a prompt instruction.",
  },
  {
    title: "Why Postgres plus Redis",
    body: "Postgres holds job state. Redis holds a job id and nothing else. Flush Redis and no job is lost: the sweeper finds every row Postgres says should be moving and re-enqueues it.",
  },
  {
    title: "How checkpoints work",
    body: "Every completed phase and every implementation turn captures a lossless binary Git patch. Recovery provisions a new container at the original commit, applies the patch, re-derives it, and continues only if the SHA-256 agrees. Starting over would look like success.",
  },
  {
    title: "Why the reviewer is separate",
    body: "The reviewer has list_files, read, search_text and submit_review. It cannot edit. Approval and a revision request are different events, and Rivet owns the loop bound.",
  },
  {
    title: "How evaluation works",
    body: "An evaluation run is an ordinary job. A second container grades the last checkpoint against hidden tests the job never saw. Success rate is passed plus failed. Errored and ungraded are counted and excluded.",
  },
  {
    title: "What happens when a worker crashes",
    body: "The lease expires, dispatch generation increments, a replacement claims immediately. The new container is not a retry from zero. It is a resume from the last checkpoint whose checksum still agrees.",
  },
  {
    title: "How publication stays once",
    body: "A minted GitHub effect writes a receipt before the caller treats it as done. The next attempt reads the receipt. That is why a reclaimed job does not open a second pull request.",
  },
  {
    title: "How secrets stay out",
    body: "The model key never enters the container, a remote URL, or an argv. Redaction sits in front of every durable write as a safety net, not as the boundary the design rests on.",
  },
] as const;

export function Tradeoffs() {
  const [lead, ...rest] = TOPICS;

  return (
    <div className="space-y-12">
      {lead ? (
        <section className="max-w-2xl space-y-3">
          <h3 className="text-xl font-semibold tracking-tight">{lead.title}</h3>
          <p className="text-base leading-relaxed">{lead.body}</p>
        </section>
      ) : null}
      <div className="grid gap-x-16 gap-y-10 md:grid-cols-2">
        {rest.map((topic) => (
          <section key={topic.title} className="space-y-2">
            <h3 className="text-lg font-semibold tracking-tight">{topic.title}</h3>
            <p className="text-base leading-relaxed">{topic.body}</p>
          </section>
        ))}
      </div>
    </div>
  );
}
