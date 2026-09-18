"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { activeSectionId, jobSections } from "@/lib/job-sections";
import { cn } from "@/lib/utils";

/**
 * How far below the sticky chrome a section has to reach before it counts as
 * the one being read: the header is 64px, this nav sits about 46px under it,
 * and the band ends well short of the fold so a panel scrolling off the bottom
 * stops claiming the highlight before it leaves.
 *
 * Pixels rather than the `rem` the rest of the layout is spelled in, because
 * `rootMargin` accepts only px and % - a `rem` value makes the constructor
 * throw, which took the whole page down to the error boundary.
 */
const OBSERVER_ROOT_MARGIN = "-120px 0px -55% 0px";

/**
 * Jump links for the job detail panels, with the current one marked.
 *
 * This is the only part of the detail page that is client code for a reason
 * other than the live stream: knowing which panel is on screen is a browser
 * fact, and the server has no way to render it. The links are ordinary `<a>`
 * fragments, so the nav still works with JavaScript off - it just highlights
 * nothing, which is what it did before.
 *
 * The bar itself scrolls horizontally on a narrow screen. It gets scroll-snap
 * so a partial pill is never left mid-scroll, a fade on the right edge while
 * there is more to reach, and the active pill is kept in view - a highlight
 * that has scrolled out of the bar is worse than none, because the reader sees
 * an unhighlighted nav and concludes they are nowhere.
 */
export function JobSectionNav({ hasPullRequest }: { hasPullRequest: boolean }) {
  // Memoized so it is a stable observer dependency rather than a new array
  // every render, which would tear down and rebuild the observer per frame.
  const sections = useMemo(() => jobSections(hasPullRequest), [hasPullRequest]);
  const [active, setActive] = useState<string | null>(null);
  const [overflowing, setOverflowing] = useState(false);
  const barRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target.id);
          else visible.delete(entry.target.id);
        }
        setActive(activeSectionId(visible, sections));
      },
      { rootMargin: OBSERVER_ROOT_MARGIN },
    );

    for (const section of sections) {
      const element = document.getElementById(section.id);
      if (element) observer.observe(element);
    }

    return () => {
      observer.disconnect();
    };
  }, [sections]);

  // Whether the fade belongs there at all. Measured rather than assumed,
  // because six pills fit on a laptop and a permanent fade over a bar with
  // nothing past its edge is a promise of content that does not exist.
  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;

    const measure = () => {
      setOverflowing(bar.scrollWidth - bar.clientWidth - bar.scrollLeft > 8);
    };

    measure();
    bar.addEventListener("scroll", measure, { passive: true });
    const resize = new ResizeObserver(measure);
    resize.observe(bar);

    return () => {
      bar.removeEventListener("scroll", measure);
      resize.disconnect();
    };
  }, []);

  return (
    <div className="sticky top-16 z-10 -mx-1 px-1 py-1">
      <div className="relative">
        <nav
          ref={barRef}
          aria-label="Job sections"
          className="border-border bg-card/85 flex snap-x snap-mandatory gap-1 overflow-x-auto rounded-lg border p-1 backdrop-blur-md [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {sections.map((section) => (
            <SectionLink
              key={section.id}
              id={section.id}
              label={section.label}
              active={section.id === active}
            />
          ))}
        </nav>
        {overflowing ? (
          <span
            aria-hidden
            className="from-card pointer-events-none absolute inset-y-1 right-1 w-8 rounded-r-lg bg-gradient-to-l to-transparent"
          />
        ) : null}
      </div>
    </div>
  );
}

function SectionLink({ id, label, active }: { id: string; label: string; active: boolean }) {
  const ref = useRef<HTMLAnchorElement | null>(null);

  useEffect(() => {
    if (!active) return;
    ref.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);

  return (
    <a
      ref={ref}
      href={`#${id}`}
      aria-current={active ? "location" : undefined}
      className={cn(
        "focus-visible:ring-ring shrink-0 snap-start rounded-md px-3 py-1.5 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none",
        active
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {label}
    </a>
  );
}
