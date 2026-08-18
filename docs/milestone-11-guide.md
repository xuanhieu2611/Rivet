# Milestone 11: the local observability stack

This guide is the Stage 5 tour for Milestone 11. Stages 1 through 4 added the telemetry port, the
OTLP adapter, traces, and the metric instruments. Stage 5 gives those signals somewhere useful to go
on a laptop: an OpenTelemetry Collector, Prometheus, Tempo and Grafana, all provisioned from the
repository.

The stack is deliberately local and self-hosted. It needs Docker, but it needs no vendor account,
API token, database, Redis instance or model key.

## Part 0. The path a signal takes

```text
Rivet web or worker
        │ OTLP/HTTP :4318
        ▼
OpenTelemetry Collector
   │                 │
   │ Prometheus       │ OTLP/gRPC
   ▼                 ▼
Prometheus       Tempo
        \         /
          Grafana :3001
```

Rivet's web and worker processes export to the collector's OTLP/HTTP endpoint. The collector exposes
metrics on its Prometheus exporter endpoint, which Prometheus scrapes every 15 seconds. Traces are
forwarded over OTLP/gRPC to Tempo. Grafana is provisioned with both data sources and loads the three
Rivet dashboards from `ops/observability/grafana/dashboards`.

The collector is the only endpoint Rivet needs to know about. The default
`OTEL_EXPORTER_OTLP_ENDPOINT` is `http://localhost:4318`, matching the published collector port.

## Part 1. Start the stack

From the repository root:

```bash
pnpm obs:up
```

Check that all four services are running:

```bash
docker compose -f ops/observability/docker-compose.yml ps
```

The local endpoints are:

| Service           | URL                             | Purpose                                          |
| ----------------- | ------------------------------- | ------------------------------------------------ |
| Grafana           | <http://localhost:3001>         | Dashboards and trace exploration                 |
| Prometheus        | <http://localhost:9090>         | Metric queries and target status                 |
| Tempo             | <http://localhost:3200>         | Trace HTTP API, normally reached through Grafana |
| Collector metrics | <http://localhost:8889/metrics> | Raw Prometheus exposition from the collector     |
| OTLP/HTTP         | `http://localhost:4318`         | Rivet's trace and metric export endpoint         |

Grafana starts with the local credentials `admin` / `admin`. They are suitable for this disposable
stack only, not for a shared machine or deployment.

## Part 2. Turn telemetry on

Add these values to the root `.env.local`, which both deployables already load:

```dotenv
RIVET_TELEMETRY=otlp
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
RIVET_SERVICE_VERSION=local
```

Restart `pnpm dev` after changing the file. The web process creates request spans and the worker
creates job, phase, command, model and tool spans. Both also export the metric instruments from
Stage 4.

Telemetry is off by default. With `RIVET_TELEMETRY=off`, Rivet still runs the same work and writes
the same durable job state, but it intentionally exports no traces or metrics. If the collector is
down while telemetry is on, exports are dropped and the application continues; an observability
backend must not be able to fail a coding job.

Allow the first metric export interval to elapse before judging the dashboards. The worker default
is 15 seconds, and Prometheus then needs one scrape interval to see the collector's current values.

## Part 3. Tour the dashboards

Open <http://localhost:3001/dashboards> and choose the **Rivet** folder.

### Job overview

**Rivet - Job overview** answers whether the control plane is moving work:

- completed jobs and currently active jobs
- terminal jobs grouped by status
- p50 and p95 end-to-end job duration
- p50 and p95 queue wait
- sweeper outcomes and lease reclaims

Job duration is measured from the database's first claim timestamp to its terminal transition. Queue
wait is recorded only for the first claim, so a reclaim cannot quietly turn execution time into
queue latency.

### Worker health

**Rivet - Worker health** answers whether the workers that own leases are alive:

- the latest heartbeat value for every worker id, where `1` means the last heartbeat succeeded
- active jobs per worker
- lease reclaims grouped by the status the job came from
- sweeper outcomes by reconciliation kind
- p95 sandbox provisioning and command latency

A heartbeat is a gauge rather than a counter. The worker reports `0` before its first successful
round trip and after a failed or fenced heartbeat, so a red value is evidence about the latest lease
check rather than a claim that the process has permanently stopped.

### Model cost and latency

**Rivet - Model cost and latency** answers where model spend and time go:

- persisted model spend by provider and model
- p50 and p95 model-turn latency
- model calls and provider or harness errors
- input and output token consumption
- tool failures grouped by model and tool

The cost metric uses the same four-decimal rounding that is written to `jobs.total_cost_usd`. The
metric and the database row therefore agree at the precision a run reports.

## Part 4. Find a job trace

The job id is the stable join key across attempts. Each worker attempt opens its own root `job.run`
trace and links it to the short request trace that created the job. This is intentional: a job can
be reclaimed onto another worker or run more than once, so holding one request root open for the
whole job would misrepresent its lifecycle.

In Grafana:

1. Open **Explore** and select **Rivet Tempo**.
2. Search for the `rivet-worker` service.
3. Open a `job.run` trace and expand its phase spans.
4. Inspect the nested `sandbox.command`, `agent.session`, `agent.turn` and `agent.tool` spans.
5. Search the span attributes for `rivet.job_id` to join the attempt back to the job page.

The web request trace uses `rivet-web` and contains the route pattern and request id. The stored
`jobs.trace_context` link connects that request to the worker attempt without pretending they are
one long-lived trace.

The dashboards intentionally do not use job ids as metric labels. Job ids have high cardinality and
belong in traces and the database, not in a Prometheus time series.

## Part 5. Inspect the raw signals

Prometheus is useful when a dashboard query needs checking. Try these in
<http://localhost:9090/graph>:

```promql
rivet_jobs_active_ratio
```

```promql
sum by (status) (rate({__name__=~"rivet_jobs_finished(_total)?"}[5m]))
```

```promql
histogram_quantile(
  0.95,
  sum by (le) (rate({__name__=~"rivet_model_latency(_milliseconds)?_bucket"}[5m]))
)
```

The regular expressions account for the collector's optional Prometheus unit and counter suffix
normalization. The dashboard queries use the same form, so they remain useful across the supported
collector versions.

## Part 6. Stop and reset

Stop the services while keeping their local history:

```bash
pnpm obs:down
```

To remove the named Prometheus, Tempo and Grafana volumes as well:

```bash
docker compose -f ops/observability/docker-compose.yml down -v --remove-orphans
```

The second command deletes local traces, metric history and Grafana state. Use it when a clean
observability session is intentional.

## Part 7. When the stack is quiet

| Symptom                                           | Check                                                                                                                                              |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| No dashboards appear                              | Confirm `pnpm obs:up` mounted the provisioning directory and inspect `docker compose -f ops/observability/docker-compose.yml logs grafana`         |
| No metrics                                        | Confirm `RIVET_TELEMETRY=otlp`, restart web and worker, then inspect Prometheus target `rivet-otel-collector`                                      |
| No traces                                         | Inspect `docker compose -f ops/observability/docker-compose.yml logs collector tempo` and verify the collector endpoint is `http://localhost:4318` |
| A dashboard has no recent points                  | Wait through the 15-second export and scrape intervals, then run `rivet_jobs_active` in Prometheus                                                 |
| The application fails because the stack is absent | It should not. Telemetry export failures are caught and logged; check for an unrelated configuration error                                         |

The stack is development infrastructure, not part of `pnpm build`, `pnpm test`, `pnpm lint` or
`pnpm typecheck`. Those commands remain runnable without Docker, Postgres, Redis or a collector.
