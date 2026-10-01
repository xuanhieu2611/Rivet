"use client";

import { useEffect, useRef, useState } from "react";

interface Step {
  title: string;
  body: string;
  detail: string;
  shot: { src: string; alt: string; width: number; height: number };
}

const STEPS: readonly Step[] = [
  {
    title: "Start from an issue",
    body: "Pick a GitHub issue, or describe the task yourself. Rivet clones the repository into a fresh, disposable container and records how its tests, typecheck and lint behave before anything changes.",
    detail:
      "The baseline matters later: it is how Rivet tells a failure it caused from one that was already there.",
    shot: {
      src: "/shots/issue.png",
      alt: "The GitHub issue Rivet was given: prevent concurrent room double-booking",
      width: 1440,
      height: 1000,
    },
  },
  {
    title: "Plan before touching code",
    body: "A planning agent reads the codebase and writes a structured plan: what is wrong, which files matter, how to reproduce it, how to fix it, and how to prove the fix.",
    detail:
      "The planner can list, read and search files. It has no tool that can edit one, and Rivet checks that before the session starts.",
    shot: {
      src: "/shots/plan.png",
      alt: "Rivet's implementation plan panel with problem interpretation and relevant components",
      width: 1440,
      height: 1000,
    },
  },
  {
    title: "Write the change in a sandbox",
    body: "A coding agent makes the change inside the container, running commands and tests as it goes. Progress is saved after every step.",
    detail:
      "Each step is a checksum-verified Git patch, so if a worker crashes, a replacement resumes from the last good step instead of starting over.",
    shot: {
      src: "/shots/diff.png",
      alt: "The working tree diff Rivet produced, adding a unique index to booking slots",
      width: 1440,
      height: 1000,
    },
  },
  {
    title: "Check the work",
    body: "Rivet reruns the project's own tests, typecheck and lint, then compares each result with the baseline from step one.",
    detail:
      "New test failures are named individually, so a suite that was already red cannot hide a regression the change introduced.",
    shot: {
      src: "/shots/validation.png",
      alt: "Rivet's validation panel showing the test suite, typecheck and lint verified against the baseline",
      width: 1440,
      height: 1000,
    },
  },
  {
    title: "Get a second opinion",
    body: "A separate reviewer agent reads the issue, the plan, the diff and the test results. It approves, or sends specific feedback back for another round.",
    detail:
      "The reviewer is read-only, and Rivet, not the model, decides how many revision rounds a job is allowed.",
    shot: {
      src: "/shots/review.png",
      alt: "Rivet's independent review panel showing an approval with no blocking findings",
      width: 1440,
      height: 1000,
    },
  },
  {
    title: "Open the pull request",
    body: "Rivet commits the validated change, pushes a branch and opens an ordinary pull request for a person to review and merge.",
    detail:
      "Every GitHub action records a receipt first, so a retry or a recovered job never pushes twice or opens a duplicate pull request.",
    shot: {
      src: "/shots/pull-request.png",
      alt: "The pull request Rivet opened on GitHub for the double-booking fix",
      width: 1440,
      height: 1000,
    },
  },
];

export function HowItWorks() {
  const [active, setActive] = useState(0);
  const stepRefs = useRef<(HTMLLIElement | null)[]>([]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const index = stepRefs.current.indexOf(entry.target as HTMLLIElement);
          if (index >= 0) setActive(index);
        }
      },
      { rootMargin: "-45% 0px -45% 0px" },
    );
    for (const element of stepRefs.current) if (element) observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="grid grid-cols-1 gap-12 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] lg:gap-16">
      <ol className="space-y-12 lg:space-y-0">
        {STEPS.map((step, index) => (
          <li
            key={step.title}
            ref={(element) => {
              stepRefs.current[index] = element;
            }}
            className="lg:flex lg:min-h-[62vh] lg:items-center"
          >
            <div
              className={[
                "border-l-2 pl-5 transition-colors duration-300 lg:py-2",
                active === index ? "border-teal" : "border-rule lg:opacity-55",
              ].join(" ")}
            >
              <p className="type-mono text-teal text-sm tabular-nums">
                {String(index + 1).padStart(2, "0")}
              </p>
              <h3 className="type-heading mt-2 text-2xl">{step.title}</h3>
              <p className="mt-3 text-[1.0625rem] leading-relaxed">{step.body}</p>
              <p className="text-muted mt-3 text-[0.9375rem] leading-relaxed">{step.detail}</p>
              <Shot step={step} className="mt-6 lg:hidden" />
            </div>
          </li>
        ))}
      </ol>
      <div className="hidden lg:block">
        <div className="sticky top-[calc(50vh-15rem)]">
          <div className="relative aspect-[1440/1000]">
            {STEPS.map((step, index) => (
              <Shot
                key={step.title}
                step={step}
                className={[
                  "absolute inset-0 transition-[opacity,transform] duration-500 ease-[cubic-bezier(0.23,1,0.32,1)]",
                  active === index ? "opacity-100" : "pointer-events-none translate-y-2 opacity-0",
                ].join(" ")}
                hidden={active !== index}
              />
            ))}
          </div>
          <p className="text-faint mt-4 text-sm" aria-live="polite">
            Step {active + 1} of {STEPS.length}: {STEPS[active]?.title}
          </p>
        </div>
      </div>
    </div>
  );
}

function Shot({ step, className, hidden }: { step: Step; className?: string; hidden?: boolean }) {
  return (
    <figure className={["shot", className ?? ""].join(" ")} aria-hidden={hidden ? true : undefined}>
      <img
        src={step.shot.src}
        alt={step.shot.alt}
        width={step.shot.width}
        height={step.shot.height}
        loading="lazy"
        decoding="async"
        className="h-full w-full object-cover object-top"
      />
    </figure>
  );
}
