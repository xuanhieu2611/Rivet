"use client";

import { useReducedMotion } from "motion/react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { startTransition, useEffect, useRef, type MouseEvent, type ReactNode } from "react";

import {
  isPlainLeftClick,
  JOB_TITLE_VIEW_TRANSITION_NAME,
  VIEW_TRANSITION_TIMEOUT_MS,
  viewTransitionStarter,
} from "@/lib/view-transition";

/**
 * A job title on the list that carries its own title into the detail page.
 *
 * It stays an ordinary `next/link` in every case the transition cannot run -
 * reduced motion, a browser without the API, a modified click, JavaScript off -
 * so the animation is additive and the navigation never depends on it. The name
 * is applied imperatively immediately before the snapshot is taken rather than
 * through a `style` prop: `startViewTransition` captures the DOM the moment it
 * is called, and a React state update would not have landed yet.
 */
export function JobTitleLink({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const reduceMotion = useReducedMotion() === true;
  const anchorRef = useRef<HTMLAnchorElement>(null);
  const settleRef = useRef<(() => void) | null>(null);

  // Two ways the router can finish, and the transition has to end on either.
  // The usual one is this component going away with the list; the other is a
  // route change that leaves it mounted, which the pathname catches.
  useEffect(() => {
    const pending = settleRef.current;
    settleRef.current = null;
    pending?.();
  }, [pathname]);

  useEffect(
    () => () => {
      const pending = settleRef.current;
      settleRef.current = null;
      pending?.();
    },
    [],
  );

  function onClick(event: MouseEvent<HTMLAnchorElement>) {
    const element = anchorRef.current;
    if (element === null || reduceMotion || !isPlainLeftClick(event)) return;

    const start = viewTransitionStarter(document);
    if (start === null) return;

    event.preventDefault();
    element.style.setProperty("view-transition-name", JOB_TITLE_VIEW_TRANSITION_NAME);

    const transition = start(
      () =>
        new Promise<void>((resolve) => {
          const timer = window.setTimeout(() => {
            settleRef.current = null;
            resolve();
          }, VIEW_TRANSITION_TIMEOUT_MS);

          settleRef.current = () => {
            window.clearTimeout(timer);
            resolve();
          };

          startTransition(() => {
            router.push(href);
          });
        }),
    );

    void Promise.resolve(transition.finished)
      .catch(() => undefined)
      .finally(() => {
        // The list is usually gone by now. When it is not - an aborted
        // transition, a back navigation - the name has to come off, or the
        // next transition finds two elements claiming it.
        if (element.isConnected) element.style.removeProperty("view-transition-name");
      });
  }

  return (
    <Link ref={anchorRef} href={href} className={className} onClick={onClick}>
      {children}
    </Link>
  );
}
