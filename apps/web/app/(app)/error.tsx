"use client";

import { useEffect } from "react";

import { Button } from "@/components/ui/button";

/**
 * The app shell's error boundary.
 *
 * Every page in this group reads Postgres on every request, so a database
 * hiccup is an ordinary thing to survive rather than an impossible one - and
 * Next's default error screen is not a Rivet surface. The digest is shown
 * because a server error's message is deliberately not sent to the browser, and
 * the digest is the only handle a reader has for finding the real one in the
 * worker or web logs.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("A Rivet page failed to render.", error);
  }, [error]);

  return (
    <div className="border-border mx-auto max-w-lg rounded-xl border border-dashed px-6 py-16 text-center">
      <h1 className="text-base font-medium">Something failed on the way to this page.</h1>
      <p className="text-muted-foreground mx-auto mt-2 max-w-md text-sm">
        The read did not complete. Jobs keep running whatever this page does - nothing here changes
        job state, so retrying is safe.
      </p>
      {error.digest ? (
        <p className="text-muted-foreground mt-4 font-mono text-xs">digest {error.digest}</p>
      ) : null}
      <Button className="mt-6" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
