"use client";

import { useState } from "react";

import { LINKS } from "@/lib/links";

/**
 * A poster until the visitor asks for the video. The YouTube player is about a
 * megabyte of script and a set of third-party cookies; nobody who only skims
 * the page should pay for either. The embed uses the no-cookie host.
 */
export function DemoVideo() {
  const [playing, setPlaying] = useState(false);

  if (playing) {
    return (
      <div className="shot aspect-video">
        <iframe
          src={`https://www.youtube-nocookie.com/embed/${LINKS.videoId}?autoplay=1&rel=0`}
          title="Rivet: a GitHub issue becomes a tested pull request"
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
          allowFullScreen
          className="h-full w-full"
        />
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setPlaying(true)}
      className="shot group relative block aspect-video w-full cursor-pointer text-left"
      aria-label="Play the Rivet demo video (3 minutes 11 seconds)"
    >
      <img
        src="/shots/demo-poster.png"
        alt=""
        width={1440}
        height={810}
        loading="lazy"
        decoding="async"
        className="h-full w-full object-cover opacity-70 transition-opacity duration-300 group-hover:opacity-80"
      />
      <span className="from-ground/90 via-ground/30 absolute inset-0 bg-gradient-to-t to-transparent" />
      <span className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-4 p-5 sm:p-8">
        <span>
          <span className="type-heading block text-xl sm:text-3xl">
            Watch a real run, start to finish
          </span>
          <span className="text-muted mt-1.5 block text-sm sm:text-base">
            3 minutes 11 seconds, from GitHub issue to pull request
          </span>
        </span>
        <span className="bg-teal text-teal-ink grid size-14 shrink-0 place-items-center rounded-full transition-transform duration-200 group-hover:scale-105 group-active:scale-95 sm:size-16">
          <svg viewBox="0 0 24 24" className="ml-1 size-6" fill="currentColor" aria-hidden="true">
            <path d="M8 5.14v13.72a1 1 0 0 0 1.52.85l11.02-6.86a1 1 0 0 0 0-1.7L9.52 4.29A1 1 0 0 0 8 5.14Z" />
          </svg>
        </span>
      </span>
    </button>
  );
}
