export function ArchitectureDiagram() {
  return (
    <figure className="space-y-4">
      <svg
        role="img"
        aria-labelledby="architecture-title architecture-desc"
        viewBox="0 0 960 620"
        className="h-auto w-full overflow-hidden rounded-[var(--radius)]"
      >
        <title id="architecture-title">Rivet architecture and sandbox trust boundary</title>
        <desc id="architecture-desc">
          The browser reaches the Next.js web app. The web app and worker both call core directly.
          Postgres holds durable state, while Redis carries only job identifiers. Core uses queue,
          sandbox, coding agent, and telemetry ports. Pi and the model key stay on the trusted
          worker host, while repository code and tool execution stay in an untrusted container.
        </desc>
        <defs>
          <marker
            id="architecture-arrow"
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="5"
            markerHeight="5"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--landing-rivet)" />
          </marker>
        </defs>

        <rect width="960" height="620" fill="var(--landing-still)" />
        <rect x="0.5" y="0.5" width="959" height="619" fill="none" stroke="var(--landing-rule)" />

        <g stroke="var(--landing-grid)" strokeOpacity="0.1" strokeWidth="0.7">
          {Array.from({ length: 19 }, (_, i) => (
            <line key={`v${String(i)}`} x1={48 + i * 48} y1="16" x2={48 + i * 48} y2="604" />
          ))}
          {Array.from({ length: 12 }, (_, i) => (
            <line key={`h${String(i)}`} x1="16" y1={28 + i * 48} x2="944" y2={28 + i * 48} />
          ))}
        </g>

        <text
          x="28"
          y="34"
          fill="var(--landing-muted)"
          fontSize="13"
          fontFamily="var(--font-mono), ui-monospace, monospace"
        >
          Request path
        </text>

        <Box x={36} y={58} w={154} h={64} label="Browser" sub="pages + SSE" />
        <Box x={262} y={58} w={178} h={64} label="Next.js web" sub="RSC + API routes" />
        <Box x={720} y={58} w={188} h={64} label="Worker" sub="lease + pipeline" />
        <Box x={401} y={164} w={218} h={80} label="Shared core" sub="one domain library" accent />

        <Line x1={190} y1={90} x2={262} y2={90} />
        <Line x1={351} y1={122} x2={450} y2={164} />
        <Line x1={814} y1={122} x2={570} y2={164} />

        <text
          x="28"
          y="282"
          fill="var(--landing-muted)"
          fontSize="13"
          fontFamily="var(--font-mono), ui-monospace, monospace"
        >
          Durable state and replaceable ports
        </text>

        <Box x={36} y={306} w={194} h={70} label="Postgres" sub="state + event ledger" />
        <Line x1={401} y1={218} x2={230} y2={341} />

        <Port x={282} y={306} w={136} label="JobQueue" />
        <Port x={438} y={306} w={136} label="Sandbox" />
        <Port x={594} y={306} w={136} label="CodingAgent" />
        <Port x={750} y={306} w={136} label="Telemetry" />

        <Line x1={465} y1={244} x2={350} y2={306} />
        <Line x1={495} y1={244} x2={506} y2={306} />
        <Line x1={525} y1={244} x2={662} y2={306} />
        <Line x1={555} y1={244} x2={818} y2={306} />

        <Box x={36} y={458} w={194} h={72} label="Redis / BullMQ" sub="job id + delivery only" />
        <Line x1={350} y1={354} x2={230} y2={494} />

        <g>
          <rect
            x="594"
            y="414"
            width="292"
            height="116"
            fill="var(--landing-paper)"
            stroke="var(--landing-ink)"
            strokeWidth="1.4"
          />
          <text
            x="614"
            y="440"
            fill="var(--landing-muted)"
            fontSize="12"
            fontFamily="var(--font-mono), ui-monospace, monospace"
          >
            TRUSTED WORKER HOST
          </text>
          <text
            x="614"
            y="472"
            fill="var(--landing-ink)"
            fontSize="16"
            fontFamily="var(--font-sans), ui-sans-serif, sans-serif"
            fontWeight="600"
          >
            Pi sessions
          </text>
          <text
            x="614"
            y="496"
            fill="var(--landing-muted)"
            fontSize="13"
            fontFamily="var(--font-mono), ui-monospace, monospace"
          >
            planner · implementer · reviewer
          </text>
          <rect
            x="764"
            y="452"
            width="100"
            height="38"
            fill="color-mix(in oklch, var(--landing-rivet) 12%, var(--landing-paper))"
            stroke="var(--landing-rivet)"
          />
          <text
            x="814"
            y="476"
            textAnchor="middle"
            fill="var(--landing-ink)"
            fontSize="12"
            fontFamily="var(--font-mono), ui-monospace, monospace"
          >
            model key
          </text>
        </g>
        <Line x1={662} y1={354} x2={690} y2={414} />

        <g>
          <rect
            x="282"
            y="414"
            width="272"
            height="170"
            fill="var(--landing-paper)"
            stroke="var(--landing-rivet)"
            strokeWidth="1.6"
            strokeDasharray="7 6"
          />
          <text
            x="302"
            y="440"
            fill="var(--landing-rivet)"
            fontSize="12"
            fontFamily="var(--font-mono), ui-monospace, monospace"
          >
            UNTRUSTED CONTAINER
          </text>
          <text
            x="302"
            y="474"
            fill="var(--landing-ink)"
            fontSize="16"
            fontFamily="var(--font-sans), ui-sans-serif, sans-serif"
            fontWeight="600"
          >
            Repository sandbox
          </text>
          <text
            x="302"
            y="501"
            fill="var(--landing-muted)"
            fontSize="13"
            fontFamily="var(--font-mono), ui-monospace, monospace"
          >
            source · dependencies · tests
          </text>
          <line x1="302" y1="520" x2="534" y2="520" stroke="var(--landing-rule)" />
          <text
            x="302"
            y="548"
            fill="var(--landing-muted)"
            fontSize="13"
            fontFamily="var(--font-mono), ui-monospace, monospace"
          >
            no model key · no control-plane secrets
          </text>
        </g>
        <Line x1={506} y1={354} x2={468} y2={414} />
        <Line x1={594} y1={494} x2={554} y2={494} label="sandbox-backed tools" />

        <Box x={750} y={548} w={136} h={42} label="OTLP" sub="" compact />
        <Line x1={818} y1={354} x2={818} y2={548} />
      </svg>
      <figcaption className="text-landing-muted max-w-3xl text-sm leading-relaxed">
        The web app and worker share core without an HTTP hop between them. Postgres is
        authoritative; Redis can be flushed and the sweeper will reconstruct delivery. Pi keeps the
        model credential on the trusted host, while every repository read, edit, and command crosses
        into the disposable container through a sandbox-backed tool.
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
  accent = false,
  compact = false,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  sub: string;
  accent?: boolean;
  compact?: boolean;
}) {
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        fill={accent ? "var(--muted)" : "var(--landing-paper)"}
        stroke={accent ? "var(--landing-rivet)" : "var(--landing-ink)"}
        strokeWidth={accent ? 1.8 : 1.4}
      />
      <text
        x={x + w / 2}
        y={y + (compact ? 26 : 29)}
        textAnchor="middle"
        fill="var(--landing-ink)"
        fontSize={compact ? 14 : 16}
        fontFamily="var(--font-sans), ui-sans-serif, sans-serif"
        fontWeight="600"
      >
        {label}
      </text>
      {sub ? (
        <text
          x={x + w / 2}
          y={y + 52}
          textAnchor="middle"
          fill="var(--landing-muted)"
          fontSize="12"
          fontFamily="var(--font-mono), ui-monospace, monospace"
        >
          {sub}
        </text>
      ) : null}
    </g>
  );
}

function Port({ x, y, w, label }: { x: number; y: number; w: number; label: string }) {
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={w}
        height="48"
        fill="color-mix(in oklch, var(--landing-rivet) 9%, var(--landing-paper))"
        stroke="var(--landing-rivet)"
        strokeWidth="1.3"
      />
      <text
        x={x + w / 2}
        y={y + 29}
        textAnchor="middle"
        fill="var(--landing-ink)"
        fontSize="13"
        fontFamily="var(--font-mono), ui-monospace, monospace"
      >
        {label}
      </text>
    </g>
  );
}

function Line({
  x1,
  y1,
  x2,
  y2,
  label,
}: {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  label?: string;
}) {
  return (
    <g>
      <line
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        stroke="var(--landing-rivet)"
        strokeWidth="1.7"
        markerEnd="url(#architecture-arrow)"
      />
      {label ? (
        <text
          x={(x1 + x2) / 2}
          y={(y1 + y2) / 2 - 8}
          textAnchor="middle"
          fill="var(--landing-muted)"
          fontSize="11"
          fontFamily="var(--font-mono), ui-monospace, monospace"
        >
          {label}
        </text>
      ) : null}
    </g>
  );
}
