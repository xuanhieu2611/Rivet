"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  PHASES,
  RUN,
  RUN_LINES,
  formatClock,
  revealDelayMs,
  type LineKind,
  type RunLine,
} from "@/lib/run-script";

const ALL = RUN_LINES.length;

/**
 * Replays the recorded booking job's event log as a compressed console.
 *
 * The server render (and any visitor who prefers reduced motion) gets the
 * finished state, so the page is complete without JavaScript and nothing
 * flashes empty before hydration decides to animate.
 */
export function RunConsole() {
  const [shown, setShown] = useState(ALL);
  const [clockMs, setClockMs] = useState<number>(RUN.durationMs);
  const [playing, setPlaying] = useState(false);
  const [hasPlayed, setHasPlayed] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLOListElement>(null);
  const timers = useRef<number[]>([]);
  const frame = useRef<number | null>(null);

  const stop = useCallback(() => {
    for (const id of timers.current) window.clearTimeout(id);
    timers.current = [];
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  }, []);

  const play = useCallback(() => {
    stop();
    setShown(0);
    setClockMs(0);
    setPlaying(true);
    setHasPlayed(true);

    let elapsed = 400;
    RUN_LINES.forEach((line, index) => {
      const delay = index === 0 ? elapsed : (elapsed += revealDelayMs(index));
      timers.current.push(
        window.setTimeout(() => {
          setShown(index + 1);
          const next = RUN_LINES[index + 1];
          if (!next) {
            setClockMs(line.at);
            setPlaying(false);
            return;
          }
          // Run the clock from this event to the next one over the pause
          // before it, so a long real gap reads as time passing quickly.
          const span = revealDelayMs(index + 1);
          const start = performance.now();
          const tick = (now: number) => {
            const progress = Math.min(1, (now - start) / span);
            setClockMs(line.at + (next.at - line.at) * progress);
            if (progress < 1) frame.current = requestAnimationFrame(tick);
          };
          if (frame.current !== null) cancelAnimationFrame(frame.current);
          frame.current = requestAnimationFrame(tick);
        }, delay),
      );
    });
  }, [stop]);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const root = rootRef.current;
    if (!root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          play();
        }
      },
      { threshold: 0.35 },
    );
    observer.observe(root);
    return () => {
      observer.disconnect();
      stop();
    };
  }, [play, stop]);

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [shown]);

  const visible = RUN_LINES.slice(0, shown);
  const current = visible.at(-1);
  const done = shown === ALL;
  const activeIndex = current ? PHASES.findIndex((phase) => phase.id === current.phase) : -1;

  return (
    <div
      ref={rootRef}
      className="border-rule bg-surface overflow-hidden rounded-xl border shadow-[0_40px_120px_-40px_rgb(0_0_0/0.8)]"
    >
      <div className="border-rule flex items-start justify-between gap-4 border-b px-4 py-3 sm:px-5">
        <div className="min-w-0">
          <p className="truncate text-[0.9375rem] font-semibold">{RUN.title}</p>
          <p className="text-muted mt-0.5 truncate text-[0.8125rem]">
            {RUN.repo} issue #{RUN.issue}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <span className="type-mono text-muted text-[0.8125rem] tabular-nums" aria-hidden="true">
            {formatClock(clockMs)}
          </span>
          <StatusPill done={done} playing={playing} />
        </div>
      </div>

      <ol className="border-rule grid grid-cols-7 gap-px border-b" aria-label="Pipeline phases">
        {PHASES.map((phase, index) => {
          const state =
            done || index < activeIndex ? "done" : index === activeIndex ? "active" : "todo";
          return (
            <li
              key={phase.id}
              className="bg-surface flex flex-col gap-2 px-1 pt-3 pb-2.5 sm:px-2.5"
            >
              <span
                className={[
                  "h-1 rounded-full transition-colors duration-300",
                  state === "todo" ? "bg-rule" : "bg-teal",
                  state === "active" ? "phase-active" : "",
                ].join(" ")}
              />
              <span
                className={[
                  "sr-only truncate text-xs sm:not-sr-only",
                  state === "todo" ? "text-faint" : "text-ink",
                ].join(" ")}
              >
                {phase.label}
              </span>
            </li>
          );
        })}
      </ol>

      <ol
        ref={logRef}
        className="type-mono h-[19rem] overflow-hidden px-4 py-3 text-[0.75rem] leading-[1.55rem] sm:h-[22rem] sm:px-5 sm:text-[0.78rem]"
        aria-label="Recorded event log"
      >
        {visible.map((line, index) => (
          <ConsoleLine key={`${line.at}-${String(index)}`} line={line} animate={hasPlayed} />
        ))}
      </ol>

      <div className="border-rule border-t">
        {done ? (
          <ResultCard onReplay={play} />
        ) : (
          <div className="text-faint flex h-[5.25rem] items-center px-5 text-[0.8125rem]">
            Working{current ? `: ${PHASES[activeIndex]?.label ?? ""}` : ""}
          </div>
        )}
      </div>
    </div>
  );
}

function StatusPill({ done, playing }: { done: boolean; playing: boolean }) {
  if (done) {
    return (
      <span className="border-pass/30 bg-pass/10 text-pass rounded-full border px-2.5 py-0.5 text-xs font-medium">
        Completed
      </span>
    );
  }
  return (
    <span className="border-teal/30 bg-teal/10 text-teal flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium">
      <span
        className={["bg-teal size-1.5 rounded-full", playing ? "phase-active" : ""].join(" ")}
      />
      Running
    </span>
  );
}

const GLYPH: Record<LineKind, { mark: string; className: string }> = {
  phase: { mark: "▸", className: "text-teal" },
  note: { mark: "·", className: "text-faint" },
  cmd: { mark: "$", className: "text-faint" },
  agent: { mark: "›", className: "text-muted" },
  tool: { mark: "↳", className: "text-faint" },
  ok: { mark: "✓", className: "text-pass" },
  fail: { mark: "✗", className: "text-fail" },
  pr: { mark: "↗", className: "text-teal" },
};

function ConsoleLine({ line, animate }: { line: RunLine; animate: boolean }) {
  const glyph = GLYPH[line.kind];
  return (
    <li className={["flex gap-3", animate ? "console-line" : ""].join(" ")}>
      <span className="text-faint w-[2.6rem] shrink-0 tabular-nums">{formatClock(line.at)}</span>
      <span className={`w-3 shrink-0 text-center ${glyph.className}`} aria-hidden="true">
        {glyph.mark}
      </span>
      <span
        className={[
          "min-w-0 flex-1 truncate",
          line.kind === "phase" ? "text-ink font-semibold" : "",
          line.kind === "agent" ? "text-muted italic" : "",
          line.kind === "fail" ? "text-fail" : "",
          line.kind === "ok" || line.kind === "pr" ? "text-ink" : "",
          line.kind === "note" || line.kind === "tool" ? "text-muted" : "",
          line.kind === "cmd" ? "text-ink" : "",
        ].join(" ")}
      >
        {line.kind === "tool" ? `${line.text} (sandbox)` : line.text}
      </span>
      {line.kind === "cmd" ? <span className="text-pass shrink-0">exit 0</span> : null}
    </li>
  );
}

function ResultCard({ onReplay }: { onReplay: () => void }) {
  return (
    <div className="console-card flex h-[5.25rem] items-center justify-between gap-4 px-4 sm:px-5">
      <div className="min-w-0">
        <p className="flex items-center gap-2 text-[0.9375rem] font-semibold">
          <PullRequestIcon />
          <a
            href={RUN.pullRequestUrl}
            target="_blank"
            rel="noreferrer"
            className="link decoration-transparent"
          >
            Pull request #{RUN.pullRequestNumber} opened
          </a>
        </p>
        <p className="text-muted mt-1 truncate text-[0.8125rem]">
          {RUN.filesChanged} files changed, <span className="text-pass">+{RUN.additions}</span>{" "}
          <span className="text-fail">
            {"\u2212"}
            {RUN.deletions}
          </span>
          , {RUN.modelCalls} model calls, ${RUN.costUsd}
        </p>
      </div>
      <button
        type="button"
        onClick={onReplay}
        className="btn btn-quiet shrink-0 px-3 py-1.5 text-[0.8125rem] font-medium"
      >
        Replay
      </button>
    </div>
  );
}

function PullRequestIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="text-pass size-4 shrink-0"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z" />
    </svg>
  );
}
