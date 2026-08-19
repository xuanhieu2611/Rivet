export function ArchitectureDiagram() {
  return (
    <figure className="space-y-3">
      <svg
        role="img"
        aria-labelledby="architecture-title architecture-desc"
        viewBox="0 0 760 420"
        className="h-auto w-full"
      >
        <title id="architecture-title">Rivet architecture</title>
        <desc id="architecture-desc">
          The browser and the worker both call core directly. Postgres holds job state. Redis holds
          a job id. Four ports sit under core: queue, sandbox, agent, telemetry. The model key stays
          on the worker host; the container never sees it.
        </desc>
        <rect width="760" height="420" fill="var(--landing-still)" />
        <rect x="0.5" y="0.5" width="759" height="419" fill="none" stroke="var(--landing-rule)" />

        {/* faint shop-floor grid */}
        <g stroke="var(--landing-grid)" strokeOpacity="0.18" strokeWidth="0.6">
          {Array.from({ length: 15 }, (_, i) => (
            <line key={`v${String(i)}`} x1={40 + i * 48} y1="16" x2={40 + i * 48} y2="404" />
          ))}
          {Array.from({ length: 8 }, (_, i) => (
            <line key={`h${String(i)}`} x1="16" y1={28 + i * 48} x2="744" y2={28 + i * 48} />
          ))}
        </g>

        <text
          x="28"
          y="36"
          fill="var(--landing-muted)"
          fontSize="11"
          fontFamily="var(--font-landing-mono), ui-monospace, monospace"
          letterSpacing="0.16em"
        >
          CONTROL PLANE
        </text>

        <Box x={40} y={58} w={150} h={64} label="browser" sub="pages · SSE" />
        <Box x={570} y={58} w={150} h={64} label="worker" sub="lease · pipeline" />

        <CopperLine x1={190} y1={90} x2={305} y2={148} />
        <CopperLine x1={570} y1={90} x2={455} y2={148} />

        <g>
          <rect
            x="250"
            y="148"
            width="260"
            height="88"
            fill="var(--landing-paper)"
            stroke="var(--landing-rivet)"
            strokeWidth="1.6"
          />
          <circle cx="250" cy="148" r="4" fill="var(--landing-rivet)" />
          <circle cx="510" cy="148" r="4" fill="var(--landing-rivet)" />
          <circle cx="250" cy="236" r="4" fill="var(--landing-rivet)" />
          <circle cx="510" cy="236" r="4" fill="var(--landing-rivet)" />
          <text
            x="380"
            y="186"
            textAnchor="middle"
            fill="var(--landing-ink)"
            fontSize="16"
            fontFamily="var(--font-landing-display), ui-sans-serif, sans-serif"
            fontWeight="600"
          >
            core
          </text>
          <text
            x="380"
            y="208"
            textAnchor="middle"
            fill="var(--landing-muted)"
            fontSize="11"
            fontFamily="var(--font-landing-mono), ui-monospace, monospace"
          >
            one library, two callers
          </text>
        </g>

        <CopperLine x1={320} y1={236} x2={155} y2={292} />
        <CopperLine x1={440} y1={236} x2={605} y2={292} />

        <Box x={40} y={292} w={230} h={72} label="Postgres" sub="job state · the log" />
        <Box x={490} y={292} w={230} h={72} label="Redis" sub="a job id. nothing else." />

        <text
          x="28"
          y="408"
          fill="var(--landing-muted)"
          fontSize="11"
          fontFamily="var(--font-landing-mono), ui-monospace, monospace"
        >
          ports: queue · sandbox · agent · telemetry
        </text>
        <text
          x="732"
          y="408"
          textAnchor="end"
          fill="var(--landing-rivet)"
          fontSize="11"
          fontFamily="var(--font-landing-mono), ui-monospace, monospace"
        >
          model key stays on the worker
        </text>
      </svg>
      <figcaption className="text-landing-muted font-landing-mono max-w-2xl text-[12px] leading-relaxed">
        The sandbox is a container on the far side of the sandbox port. Its tools never see the
        model key, Postgres, or Redis. Flush Redis and no job is lost.
      </figcaption>
    </figure>
  );
}

function Box({
  x,
  y,
  w,
  h,
  label,
  sub,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  sub: string;
}) {
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        fill="var(--landing-paper)"
        stroke="var(--landing-ink)"
        strokeWidth="1.1"
      />
      <text
        x={x + w / 2}
        y={y + 28}
        textAnchor="middle"
        fill="var(--landing-ink)"
        fontSize="14"
        fontFamily="var(--font-landing-display), ui-sans-serif, sans-serif"
        fontWeight="600"
      >
        {label}
      </text>
      <text
        x={x + w / 2}
        y={y + 48}
        textAnchor="middle"
        fill="var(--landing-muted)"
        fontSize="11"
        fontFamily="var(--font-landing-mono), ui-monospace, monospace"
      >
        {sub}
      </text>
    </g>
  );
}

function CopperLine({ x1, y1, x2, y2 }: { x1: number; y1: number; x2: number; y2: number }) {
  return <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--landing-rivet)" strokeWidth="1.4" />;
}
