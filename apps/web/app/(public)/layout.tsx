import { Bricolage_Grotesque, IBM_Plex_Mono, Source_Sans_3 } from "next/font/google";
import Link from "next/link";

const display = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--font-landing-display",
  display: "swap",
});

const body = Source_Sans_3({
  subsets: ["latin"],
  variable: "--font-landing-body",
  display: "swap",
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-landing-mono",
  display: "swap",
});

export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div
      data-landing
      className={`${display.variable} ${body.variable} ${mono.variable} flex min-h-svh flex-col`}
    >
      <header className="landing-rule-b">
        <div className="landing-shell flex h-14 items-center justify-between">
          <Link href="/" className="flex items-baseline gap-2">
            <span aria-hidden="true" className="landing-rivet" />
            <span className="font-landing-display text-[15px] font-semibold tracking-tight">
              Rivet
            </span>
            <span className="text-landing-muted hidden text-[11px] tracking-wide uppercase sm:inline">
              a job, not a chat
            </span>
          </Link>
          <Link href="/sign-in" className="landing-cta">
            Sign in
          </Link>
        </div>
      </header>
      <div className="flex-1">{children}</div>
    </div>
  );
}
