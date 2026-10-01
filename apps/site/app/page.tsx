import { ArchitectureDiagram } from "@/components/architecture-diagram";
import { DemoVideo } from "@/components/demo-video";
import { EngineeringProperties, Stack } from "@/components/engineering";
import { HowItWorks } from "@/components/how-it-works";
import { Results } from "@/components/results";
import { RunConsole } from "@/components/run-console";
import { formatDate } from "@/lib/format";
import { AUTHOR, LINKS } from "@/lib/links";
import { PLAYBACK_SPEEDUP, RUN } from "@/lib/run-script";

const FACTS = [
  { value: "7m 32s", label: "from issue to pull request in the run above" },
  { value: "1.4¢", label: "of model usage for its 24 model calls" },
  { value: "15 of 15", label: "benchmark tasks passed hidden tests with review" },
  { value: "1,400+", label: "automated tests, from unit tests to real containers" },
] as const;

export default function Home() {
  return (
    <>
      <a
        href="#main"
        className="bg-teal text-teal-ink sr-only z-50 rounded px-3 py-2 focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Skip to content
      </a>
      <SiteHeader />
      <main id="main">
        <section className="shell pt-12 pb-16 sm:pt-16 lg:pt-20 lg:pb-24">
          <h1 className="type-display max-w-[68rem] text-[2.6rem] sm:text-6xl lg:text-[4.4rem]">
            Give it a GitHub issue. Get back a tested pull request.
          </h1>
          <div className="mt-10 grid grid-cols-1 items-start gap-12 lg:mt-14 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-14">
            <div className="lg:pt-2">
              <p className="text-muted max-w-[34rem] text-lg leading-relaxed">
                Rivet is an autonomous software engineer. It plans a fix, writes the code in an
                isolated sandbox, runs the project&apos;s own tests, has a second agent review the
                change, and opens the pull request, recording every step along the way.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <a href="#demo" className="btn btn-primary">
                  <PlayIcon />
                  Watch the demo
                </a>
                <a href={LINKS.repo} className="btn btn-quiet" target="_blank" rel="noreferrer">
                  <GitHubIcon />
                  View the source
                </a>
              </div>
              <p className="text-faint mt-6 text-sm">
                Open source under the MIT license. Runs on your own machine.
              </p>
            </div>
            <div>
              <RunConsole />
              <p className="text-faint mt-3 text-[0.8125rem] leading-relaxed">
                A real job from {formatDate(RUN.recordedOn)}, replayed from its recorded event log
                at about {PLAYBACK_SPEEDUP} times speed.
              </p>
            </div>
          </div>
        </section>

        <section aria-label="The run in numbers" className="border-rule border-y">
          <dl className="shell grid grid-cols-2 lg:grid-cols-4">
            {FACTS.map((fact, index) => (
              <div
                key={fact.value}
                className={[
                  "border-rule py-7 pr-4",
                  index % 2 === 1 ? "border-l pl-5 sm:pl-8" : "",
                  index === 2 ? "border-t lg:border-t-0 lg:border-l lg:pl-8" : "",
                  index === 3 ? "border-t lg:border-t-0" : "",
                ].join(" ")}
              >
                <dt className="type-heading text-3xl tabular-nums sm:text-4xl">{fact.value}</dt>
                <dd className="text-muted mt-2 text-sm leading-snug">{fact.label}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section id="how" className="shell scroll-mt-20 py-24 lg:py-32">
          <SectionIntro title="How it works">
            Six steps, each one recorded. The screenshots come from the same job the console above
            replays.
          </SectionIntro>
          <div className="mt-14 lg:mt-4">
            <HowItWorks />
          </div>
        </section>

        <section id="demo" className="shell scroll-mt-20 pb-24 lg:pb-32">
          <h2 className="sr-only">Demo video</h2>
          <DemoVideo />
        </section>

        <section
          id="engineering"
          className="bg-surface/60 border-rule scroll-mt-16 border-y py-24 lg:py-32"
        >
          <div className="shell">
            <SectionIntro title="Built to be trusted with a real repository">
              Having a model write code is the easy part. Most of Rivet is the system around it:
              what happens when something fails, what the AI is allowed to touch, and how you know
              the result is right.
            </SectionIntro>
            <div className="mt-14">
              <EngineeringProperties />
            </div>
            <div className="mt-20 space-y-8">
              <h3 className="type-heading text-2xl">How the pieces fit</h3>
              <ArchitectureDiagram />
            </div>
            <div className="mt-20 space-y-8">
              <h3 className="type-heading text-2xl">Built with</h3>
              <Stack />
            </div>
          </div>
        </section>

        <section id="results" className="shell scroll-mt-20 py-24 lg:py-32">
          <SectionIntro title="Does a second reviewer help?">
            Rivet can run a job with or without the independent review step. So it was measured
            rather than assumed.
          </SectionIntro>
          <div className="mt-14">
            <Results />
          </div>
        </section>

        <section className="border-rule border-t">
          <div className="shell grid grid-cols-1 gap-12 py-24 lg:grid-cols-2 lg:gap-16 lg:py-28">
            <div>
              <h2 className="type-heading text-3xl sm:text-4xl">Built by {AUTHOR.name}</h2>
              <p className="mt-5 max-w-[36rem] text-[1.0625rem] leading-relaxed">
                I built Rivet to find out what it takes to trust an AI agent with a real repository.
                The model turned out to be the easy part. The work is everything around it:
                sandboxes, crash recovery, honest validation, and a record of every step that anyone
                can check.
              </p>
              <ul className="mt-7 flex flex-wrap gap-x-6 gap-y-3 text-[0.9375rem]">
                <AuthorLink href={AUTHOR.github} label="GitHub" />
                {AUTHOR.linkedin ? <AuthorLink href={AUTHOR.linkedin} label="LinkedIn" /> : null}
                <AuthorLink href={AUTHOR.x} label="X" />
                {AUTHOR.website ? <AuthorLink href={AUTHOR.website} label="Website" /> : null}
                <AuthorLink href={LINKS.thread} label="Engineering notes" />
              </ul>
            </div>
            <div className="border-rule lg:border-l lg:pl-16">
              <h2 className="type-heading text-3xl sm:text-4xl">Run it yourself</h2>
              <p className="text-muted mt-5 max-w-[34rem] text-[1.0625rem] leading-relaxed">
                Rivet is a self-hosted, single-operator application. Clone it, start Postgres, Redis
                and Docker, add a model key, and point it at a repository.
              </p>
              <pre className="type-mono bg-surface border-rule mt-7 overflow-x-auto rounded-lg border px-4 py-3.5 text-[0.75rem] leading-6">
                <code>
                  <span className="text-faint">$ </span>git clone {LINKS.repo}.git{"\n"}
                  <span className="text-faint">$ </span>cd Rivet && pnpm install{"\n"}
                  <span className="text-faint">$ </span>pnpm db:migrate && pnpm dev
                </code>
              </pre>
              <div className="mt-7 flex flex-wrap gap-3">
                <a
                  href={LINKS.quickStart}
                  className="btn btn-quiet"
                  target="_blank"
                  rel="noreferrer"
                >
                  Read the quick start
                </a>
                <a
                  href={LINKS.architecture}
                  className="btn btn-quiet"
                  target="_blank"
                  rel="noreferrer"
                >
                  Read the architecture
                </a>
              </div>
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}

function SiteHeader() {
  return (
    <header className="bg-ground/80 border-rule sticky top-0 z-30 border-b backdrop-blur-md">
      <div className="shell flex h-16 items-center justify-between gap-6">
        <a href="#main" className="flex items-center gap-2.5" aria-label="Rivet, back to top">
          <span className="rivet" aria-hidden="true" />
          <span className="type-heading text-lg">Rivet</span>
        </a>
        <nav aria-label="Sections" className="flex items-center gap-1 sm:gap-2">
          <NavLink href="#how" label="How it works" />
          <NavLink href="#engineering" label="Engineering" />
          <NavLink href="#results" label="Results" />
          <a
            href={LINKS.repo}
            target="_blank"
            rel="noreferrer"
            className="btn btn-quiet ml-2 px-3 py-1.5 text-sm font-medium"
          >
            <GitHubIcon />
            GitHub
          </a>
        </nav>
      </div>
    </header>
  );
}

function NavLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      className="text-muted hover:text-ink hidden rounded px-2.5 py-1.5 text-sm transition-colors md:block"
    >
      {label}
    </a>
  );
}

function SiteFooter() {
  return (
    <footer className="border-rule border-t">
      <div className="shell text-faint flex flex-col gap-4 py-10 text-sm sm:flex-row sm:items-center sm:justify-between">
        <p className="flex items-center gap-2.5">
          <span className="rivet scale-75" aria-hidden="true" />
          <span>
            Rivet is open source under the{" "}
            <a href={LINKS.license} className="link" target="_blank" rel="noreferrer">
              MIT license
            </a>
            .
          </span>
        </p>
        <ul className="flex flex-wrap gap-x-5 gap-y-2">
          <li>
            <a href={LINKS.repo} className="link" target="_blank" rel="noreferrer">
              Source
            </a>
          </li>
          <li>
            <a href={LINKS.architecture} className="link" target="_blank" rel="noreferrer">
              Architecture
            </a>
          </li>
          <li>
            <a href={LINKS.security} className="link" target="_blank" rel="noreferrer">
              Security
            </a>
          </li>
          <li>
            <a href={LINKS.video} className="link" target="_blank" rel="noreferrer">
              Demo on YouTube
            </a>
          </li>
        </ul>
      </div>
    </footer>
  );
}

function SectionIntro({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="max-w-[44rem]">
      <h2 className="type-display text-4xl sm:text-5xl">{title}</h2>
      <p className="text-muted mt-5 text-lg leading-relaxed">{children}</p>
    </div>
  );
}

function AuthorLink({ href, label }: { href: string; label: string }) {
  return (
    <li>
      <a href={href} className="link" target="_blank" rel="noreferrer">
        {label}
      </a>
    </li>
  );
}

function GitHubIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-4" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" fill="currentColor" aria-hidden="true">
      <path d="M8 5.14v13.72a1 1 0 0 0 1.52.85l11.02-6.86a1 1 0 0 0 0-1.7L9.52 4.29A1 1 0 0 0 8 5.14Z" />
    </svg>
  );
}
