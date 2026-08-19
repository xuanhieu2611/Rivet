export function VideoSlot() {
  return (
    <figure className="space-y-3">
      <div
        className="relative aspect-video w-full overflow-hidden"
        style={{ background: "var(--landing-still)", border: "1px solid var(--landing-rule)" }}
      >
        <div className="absolute inset-0 flex flex-col items-start justify-between p-5 sm:p-8">
          <p className="font-landing-mono text-landing-muted text-[11px] tracking-[0.18em] uppercase">
            60-second cut · work item 4
          </p>
          <div className="space-y-2">
            <p className="font-landing-display text-xl font-semibold tracking-tight sm:text-3xl">
              Recording forthcoming
            </p>
            <p className="text-landing-muted max-w-md text-sm leading-relaxed">
              The live demo is a real job. The public artifact is a recording of one, so a stranger
              watching never depends on a model behaving well.
            </p>
          </div>
          <p className="font-landing-mono text-[11px]" style={{ color: "var(--landing-rivet)" }}>
            poster · no playback until the cut lands
          </p>
        </div>
      </div>
      <figcaption className="text-landing-muted font-landing-mono text-[12px]">
        Sixty seconds. Hook, first-attempt failure, pull request, punchline. Script in PRD §34.
      </figcaption>
    </figure>
  );
}
