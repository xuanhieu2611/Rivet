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
      <section className="min-h-[calc(100dvh-4rem)]">
        <div className="landing-shell grid items-center gap-10 py-12 lg:grid-cols-2 lg:gap-16 lg:py-16">
          <div className="landing-hero-copy space-y-6">
            <h1 className="max-w-xl text-4xl font-semibold tracking-tight text-pretty sm:text-5xl lg:text-6xl lg:leading-[1.08]">
              You describe a task. Rivet ships the pull request.
            </h1>
            <p className="text-landing-muted max-w-[36rem] text-lg leading-relaxed text-pretty">
              Point it at a repository. Rivet plans, edits, tests, reviews, and opens a pull
              request.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Link href="/sign-in" className="landing-cta">
                Sign in
              </Link>
              <a href="#run" className="landing-cta-ghost">
                See a run
              </a>
            </div>
          </div>
          <div className="landing-hero-asset relative aspect-[4/3] w-full overflow-hidden rounded-[var(--radius)]">
            {/*
             * Native img, not next/image. The optimizer fetches the file as a
             * second request and was reading a sign-in redirect as the body.
             */}
            <img
              src="/landing/hero-rivet.jpg"
              alt="A steel rivet fastening two overlapping metal plates"
              width={1536}
              height={1024}
              fetchPriority="high"
              className="h-full w-full object-cover"
            />
          </div>
        </div>
      </section>

      <section className="landing-rule-t">
        <div className="landing-shell space-y-8 py-20">
          <h2 className="max-w-2xl text-3xl font-semibold tracking-tight text-pretty">
            The demo that does not depend on a model
          </h2>
          <VideoSlot />
        </div>
      </section>

      <section className="landing-rule-t">
        <div className="landing-shell space-y-8 py-20">
          <h2 className="max-w-2xl text-3xl font-semibold tracking-tight text-pretty">
            Two processes, one library, four ports
          </h2>
          <ArchitectureDiagram />
        </div>
      </section>

      <section id="run" className="landing-rule-t scroll-mt-24">
        <div className="landing-shell space-y-8 py-20">
          <div className="max-w-2xl space-y-3">
            <h2 className="text-3xl font-semibold tracking-tight text-pretty">
              Sixty seconds, as a ledger
            </h2>
            <p className="text-landing-muted text-base leading-relaxed">
              Stills are labeled frames until a captured run replaces them. The sequence includes
              the first-attempt failure.
            </p>
          </div>
          <RunWalkthrough />
        </div>
      </section>

      <section className="landing-rule-t">
        <div className="landing-shell space-y-8 py-20">
          <div className="max-w-2xl space-y-3">
            <h2 className="text-3xl font-semibold tracking-tight text-pretty">
              Independent review versus none
            </h2>
            <p className="text-landing-muted text-base leading-relaxed">
              Numbers from a completed evaluation suite, written into the page at authoring time.
              Not queried live, so this page still builds with no database.
            </p>
          </div>
          <ExperimentNumbers />
        </div>
      </section>

      <section className="landing-rule-t">
        <div className="landing-shell space-y-10 py-20">
          <h2 className="max-w-2xl text-3xl font-semibold tracking-tight text-pretty">
            What the system is actually arguing
          </h2>
          <Tradeoffs />
        </div>
      </section>

      <footer className="landing-rule-t">
        <div className="landing-shell flex flex-col gap-5 py-12 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-landing-muted max-w-xl text-base leading-relaxed">
            Local only. There is no public job surface. Sign in if you own the box.
          </p>
          <Link href="/sign-in" className="landing-cta w-fit">
            Sign in
          </Link>
        </div>
      </footer>
    </main>
  );
}
