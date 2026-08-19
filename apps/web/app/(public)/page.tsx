import type { Metadata } from "next";
import Link from "next/link";

import { ArchitectureDiagram } from "@/components/landing/architecture-diagram";
import { ExperimentNumbers } from "@/components/landing/experiment-numbers";
import { RunWalkthrough } from "@/components/landing/run-walkthrough";
import { Tradeoffs } from "@/components/landing/tradeoffs";
import { VideoSlot } from "@/components/landing/video-slot";

/**
 * Checked-in copy, a checked-in diagram, checked-in stills and static
 * experiment numbers. No cookies, no headers, no database. `pnpm build`
 * prerenders this page with `DATABASE_URL` unset, which is the property
 * CI's verify job exists to protect.
 */
export const dynamic = "force-static";

export const metadata: Metadata = {
  title: { absolute: "Rivet" },
  description:
    "An autonomous software engineering platform. You point it at a repository, describe a task, and it ships a pull request. The interesting part is the job around the model.",
};

export default function LandingPage() {
  return (
    <main>
      <section className="landing-shell space-y-6 py-16 sm:py-24">
        <p className="font-landing-mono text-landing-muted text-[11px] tracking-[0.18em] uppercase">
          Autonomous engineering jobs
        </p>
        <h1 className="font-landing-display max-w-3xl text-4xl font-semibold tracking-tight text-pretty sm:text-5xl">
          You describe a task. Rivet runs the job to a pull request.
        </h1>
        <p className="max-w-2xl text-lg leading-relaxed text-pretty">
          Rivet is an autonomous software engineering platform. Point it at a repository, write the
          task the way you would write a GitHub issue, and it reads, plans, edits, tests, reviews
          and opens a pull request.
        </p>
        <p className="text-landing-muted max-w-2xl text-lg leading-relaxed text-pretty">
          The interesting part is not the code generation. It is the job-execution system around the
          coding agent: a sandbox the container cannot talk to the control plane through, a worker
          that can die and be replaced, and a timeline that is true because Postgres is the log.
        </p>
        <p>
          <Link href="/sign-in" className="landing-cta inline-block">
            Sign in
          </Link>
        </p>
      </section>

      <section className="landing-rule-t">
        <div className="landing-shell space-y-6 py-16">
          <SectionKicker>Sixty seconds</SectionKicker>
          <h2 className="font-landing-display text-2xl font-semibold tracking-tight">
            The demo that does not depend on a model
          </h2>
          <VideoSlot />
        </div>
      </section>

      <section className="landing-rule-t">
        <div className="landing-shell space-y-6 py-16">
          <SectionKicker>Architecture</SectionKicker>
          <h2 className="font-landing-display text-2xl font-semibold tracking-tight">
            Two processes, one library, four ports
          </h2>
          <ArchitectureDiagram />
        </div>
      </section>

      <section className="landing-rule-t">
        <div className="landing-shell space-y-6 py-16">
          <SectionKicker>A run</SectionKicker>
          <h2 className="font-landing-display text-2xl font-semibold tracking-tight">
            The sixty-second beats, as a ledger
          </h2>
          <p className="text-landing-muted max-w-2xl text-[15px] leading-relaxed">
            Stills below are labeled frames until a captured run replaces them. The sequence is the
            public demo script, including the first-attempt failure.
          </p>
          <RunWalkthrough />
        </div>
      </section>

      <section className="landing-rule-t">
        <div className="landing-shell space-y-6 py-16">
          <SectionKicker>Experiment 1</SectionKicker>
          <h2 className="font-landing-display text-2xl font-semibold tracking-tight">
            Independent review versus none
          </h2>
          <p className="text-landing-muted max-w-2xl text-[15px] leading-relaxed">
            Numbers from a completed evaluation suite, written into the page at authoring time. Not
            queried live, so this page still builds on a machine with no database.
          </p>
          <ExperimentNumbers />
        </div>
      </section>

      <section className="landing-rule-t">
        <div className="landing-shell space-y-6 py-16">
          <SectionKicker>Tradeoffs</SectionKicker>
          <h2 className="font-landing-display text-2xl font-semibold tracking-tight">
            What the system is actually arguing
          </h2>
          <Tradeoffs />
        </div>
      </section>

      <footer className="landing-rule-t">
        <div className="landing-shell flex flex-col gap-4 py-10 sm:flex-row sm:items-end sm:justify-between">
          <p className="text-landing-muted max-w-xl text-sm leading-relaxed">
            Local only. There is no public job surface. Sign in if you own the box.
          </p>
          <Link href="/sign-in" className="landing-cta inline-block w-fit">
            Sign in
          </Link>
        </div>
      </footer>
    </main>
  );
}

function SectionKicker({ children }: { children: React.ReactNode }) {
  return (
    <p className="font-landing-mono text-landing-muted text-[11px] tracking-[0.18em] uppercase">
      {children}
    </p>
  );
}
