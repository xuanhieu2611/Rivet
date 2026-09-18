"use client";

import { LogOut, User } from "lucide-react";
import { useRef } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ThemeToggle } from "@/components/theme-toggle";

/**
 * Who you are signed in as, and the two things you can do about it.
 *
 * Sign out used to sit in the nav with the same weight as a destination, which
 * put a one-way door beside three ordinary links. It is a form POST rather than
 * a fetch because the route answers with a 303 to `/sign-in` and sets the
 * expired cookie on that response - submitting a real form is what follows the
 * redirect and applies the `Set-Cookie`.
 */
export function AccountMenu({ login }: { login: string | null }) {
  const signOutForm = useRef<HTMLFormElement>(null);

  return (
    <>
      <form ref={signOutForm} method="post" action="/api/auth/signout" className="hidden" />

      <DropdownMenu>
        <DropdownMenuTrigger
          className="text-muted-foreground hover:text-foreground hover:bg-muted/60 focus-visible:ring-ring flex size-8 shrink-0 items-center justify-center rounded-full transition-colors duration-150 focus-visible:ring-2 focus-visible:outline-none data-[state=open]:bg-muted data-[state=open]:text-foreground"
          aria-label={login ? `Account: ${login}` : "Account"}
        >
          <Avatar login={login} />
        </DropdownMenuTrigger>

        <DropdownMenuContent>
          <DropdownMenuLabel>
            {login ? `Signed in as ${login}` : "Authentication is off"}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <ThemeToggle />
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => signOutForm.current?.requestSubmit()}>
            <LogOut aria-hidden />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

/**
 * The login's first letter, or a generic glyph when there is no session -
 * under `RIVET_AUTH=off` there is nobody to name and inventing an initial
 * would be the header claiming an identity it does not have.
 */
function Avatar({ login }: { login: string | null }) {
  if (!login) return <User aria-hidden className="size-4" />;

  return (
    <span
      aria-hidden
      className="bg-primary/15 text-primary flex size-7 items-center justify-center rounded-full text-xs font-semibold uppercase"
    >
      {login.slice(0, 1)}
    </span>
  );
}
