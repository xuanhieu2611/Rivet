export function VideoSlot() {
  return (
    <figure className="space-y-3">
      <div className="relative aspect-video w-full overflow-hidden rounded-[var(--radius)]">
        <img
          src="/landing/demo-poster.jpg"
          alt="Steel plates and rivets on a fabrication bench"
          width={1536}
          height={1024}
          className="h-full w-full object-cover"
        />
        <div className="absolute inset-0 bg-[color-mix(in_oklch,var(--landing-paper)_58%,transparent)]" />
        <div className="absolute inset-0 flex flex-col justify-end p-6 sm:p-8">
          <p className="text-2xl font-semibold tracking-tight sm:text-3xl">Demo video</p>
          <p className="text-landing-muted mt-2 max-w-md text-[15px] leading-relaxed">
            Added during acceptance run H. The recording will show a real job, so a stranger
            watching never depends on a model behaving well.
          </p>
        </div>
      </div>
      <figcaption className="text-landing-muted text-sm leading-relaxed">
        Sixty seconds: hook, first-attempt failure, pull request, punchline.
      </figcaption>
    </figure>
  );
}
