import Image from "next/image";

export function VideoSlot() {
  return (
    <figure className="space-y-3">
      <div className="relative aspect-video w-full overflow-hidden rounded-[var(--radius)]">
        <Image
          src="/landing/demo-poster.jpg"
          alt="Steel plates and rivets on a fabrication bench"
          fill
          sizes="(min-width: 1024px) 70rem, 100vw"
          className="object-cover"
        />
        <div className="absolute inset-0 bg-[color-mix(in_oklch,var(--landing-paper)_58%,transparent)]" />
        <div className="absolute inset-0 flex flex-col justify-end p-6 sm:p-8">
          <p className="text-2xl font-semibold tracking-tight sm:text-3xl">Recording forthcoming</p>
          <p className="text-landing-muted mt-2 max-w-md text-[15px] leading-relaxed">
            The public artifact is a recording of a real job, so a stranger watching never depends
            on a model behaving well.
          </p>
        </div>
      </div>
      <figcaption className="text-landing-muted text-sm leading-relaxed">
        Sixty seconds: hook, first-attempt failure, pull request, punchline.
      </figcaption>
    </figure>
  );
}
