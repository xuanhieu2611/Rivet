import Link from "next/link";

export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div data-landing className="flex min-h-svh flex-col">
      <header className="landing-rule-b bg-background/85 sticky top-0 z-20 backdrop-blur-md">
        <div className="landing-shell flex h-16 items-center justify-between">
          <Link href="/" className="flex items-center gap-2.5">
            <span aria-hidden="true" className="landing-rivet" />
            <span className="text-[15px] font-semibold tracking-tight">Rivet</span>
          </Link>
          <Link href="/sign-in" className="landing-cta landing-cta-compact">
            Sign in
          </Link>
        </div>
      </header>
      <div className="flex-1">{children}</div>
    </div>
  );
}
