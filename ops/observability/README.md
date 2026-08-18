# Rivet observability stack

This directory contains the local OpenTelemetry stack used by Rivet:

```text
Rivet web / worker
        │ OTLP/HTTP :4318
        ▼
OpenTelemetry Collector
   │                 │
   │ Prometheus      │ OTLP/gRPC
   ▼                 ▼
Prometheus       Tempo
        \         /
          Grafana :3001
```

Start it from the repository root with:

```bash
pnpm obs:up
```

Grafana is available at <http://localhost:3001> with `admin` / `admin`. Prometheus is at
<http://localhost:9090>; the collector's Prometheus endpoint is at <http://localhost:8889>; and
Tempo's HTTP API is at <http://localhost:3200>.

The stack keeps data in named Docker volumes. Stop the services without deleting history with
`pnpm obs:down`; use `docker compose -f ops/observability/docker-compose.yml down -v` when a clean
reset is intentional.
