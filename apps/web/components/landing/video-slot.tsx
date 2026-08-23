const DEMO_URL = "https://youtu.be/X_b03iHhXzU";

export function VideoSlot() {
  return (
    <figure className="space-y-3">
      <a
        href={DEMO_URL}
        target="_blank"
        rel="noreferrer"
        aria-label="Watch the Rivet demo on YouTube"
        className="relative block aspect-video w-full overflow-hidden rounded-[var(--radius)] focus-visible:outline-2 focus-visible:outline-offset-4"
      >
        <img
          src="/landing/demo-poster.jpg"
          alt="Steel plates and rivets on a fabrication bench"
          width={1536}
          height={1024}
          className="h-full w-full object-cover"
        />
        <div className="absolute inset-0 bg-[color-mix(in_oklch,var(--landing-paper)_58%,transparent)]" />
        <div className="absolute inset-0 flex flex-col justify-end p-6 sm:p-8">
          <p className="text-2xl font-semibold tracking-tight sm:text-3xl">Watch the public demo</p>
          <p className="text-landing-muted mt-2 max-w-md text-[15px] leading-relaxed">
            A GitHub issue becomes a tested, independently reviewed pull request in 3 minutes 11
            seconds.
          </p>
          <span className="mt-5 w-fit border-b border-current pb-1 text-sm font-semibold">
            Watch on YouTube ↗
          </span>
        </div>
      </a>
      <figcaption className="text-landing-muted text-sm leading-relaxed">
        Planning, sandboxed implementation, deterministic validation, review, and publication.
      </figcaption>
    </figure>
  );
}
