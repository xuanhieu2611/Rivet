# UI improvement backlog

A prioritized, self-contained list of design work items for `apps/web`. Each item names the files it
touches, what to change, and how to tell it is done. Nothing here changes a table, a job status, an
event type or a failure category - this is presentation only.

Work top to bottom. Tier 1 changes how the product feels to operate; Tier 2 is a consistency pass
you can do in one sitting; Tier 3 and 4 are polish.

Audit date: 2026-09-17. Surface audited: both layouts, all six app pages, the public landing and
sign-in pages, every panel component, the design tokens in `app/globals.css`, and the shadcn
primitives under `components/ui/`.

---

## Tier 1 - biggest wins

**Done.** All five shipped together; see the notes under each item for what was built and what was
deliberately left out.

### 1. Phase stepper on the job detail page

- [x] **Problem.** A running job shows one status word (`LiveStatusBadge`) and an append-only log.
      There are fourteen statuses and a fixed pipeline, but nothing shows where in that pipeline the
      run is or how much is left. Reading the log is the only answer, and reading a log is work.
- [x] **Files.** New `components/job-live/phase-stepper.tsx`; mounted in
      `app/(app)/jobs/[id]/page.tsx` directly under the title block (around line 96). Reads from
      `components/job-live/job-live-provider.tsx`, so it stays live without a new data path.
- [x] **What to build.** Seven segments for `provisioning`, `analyzing`, `planning`, `implementing`,
      `testing`, `reviewing`, `finalizing`. Completed segments filled, current segment animated,
      remaining segments ghosted. Elapsed per phase on hover, derived from the `phase.completed`
      events already in the timeline. Terminal statuses (`completed`, `failed`, `cancelled`,
      `budget_exceeded`, `timed_out`) collapse the stepper into a single outcome line.
- [x] **Watch out for.** `revising` is a loop back, not an eighth step - render it as a repeat badge
      on `implementing` rather than a new segment. Respect `timelineMotion.reduceMotion`, which the
      provider already exposes.
- [x] **Done when.** A mid-run job answers "how far along is this" without scrolling, and a replayed
      job (`pnpm demo:replay`) animates through the segments in order.
- [x] **Built as.** `components/job-live/phase-progress.ts` (pure derivation, unit tested) plus
      `components/job-live/phase-stepper.tsx`. Completion is read from `phase.completed` events
      rather than inferred from position, so a checkpoint resume does not fill in the phases it
      skipped and a failure at `testing` leaves `reviewing` ghosted.

### 2. Result header: lead with the deliverable

- [x] **Problem.** The point of a job is a pull request and a diff. The PR link is currently a row
      inside a sidebar card titled "Target" (`app/(app)/jobs/[id]/page.tsx:203-260`), the diff is
      the sixth card down inside "Artifacts", and a terminal job is laid out identically to a queued
      one.
- [x] **Files.** `app/(app)/jobs/[id]/page.tsx`; likely a new `components/job-result-header.tsx`.
- [x] **What to build.** When `isTerminal(job.status)`, render above the section nav: the outcome
      sentence, a prominent "View pull request" button when `job.pullRequestUrl` exists, the diff
      stat (`3 files changed, +48/-12`, already computed in `job-artifacts-panel.tsx` as
      `formatDiffStats`), and the validation outcome badge.
- [x] **Also.** Rename the sidebar card "Target" to "Repository". Move the Artifacts card above the
      Task card in the left column.
- [x] **Done when.** Opening a finished job answers "did it work, and where is the result" in the
      first viewport, with no scrolling.
- [x] **Built as.** `components/job-result-header.tsx` plus `lib/job-outcome.ts` for the sentence
      and `lib/diff-stats.ts` for the stat, which `job-artifacts-panel.tsx` now shares rather than
      spelling itself.

### 3. Jobs list: filtering and live rows

- [x] **Problem.** `app/(app)/jobs/page.tsx` is `force-dynamic` but never refreshes, so a running
      job's row is stale the moment it renders. There is no status filter, no search, and no
      pagination past `limit: 50`.
- [x] **Files.** `app/(app)/jobs/page.tsx`, plus a small client island for the filter and the live
      dots.
- [x] **What to build.** A status filter row (All / Running / Completed / Failed) as tabs driven by
      a search param, so it stays server-rendered and linkable. A live pulse dot on rows whose
      status is non-terminal. A compact inline progress hint per active row once item 1 exists.
- [x] **Watch out for.** Keep the page a server component. The filter belongs in the URL, not in
      client state, so a filtered view is shareable and `force-dynamic` keeps meaning what it means.
- [x] **Done when.** A user with thirty jobs can find the three that are running without reading
      every row, and those three update without a manual reload.
- [x] **Built as.** `lib/job-filter.ts` plus `components/jobs-live-refresh.tsx`. `listJobs()` grew
      an optional `statuses` filter so the tab narrows in SQL - filtering the page's own window
      would search the newest fifty rows and answer "no failed jobs" for an account with plenty.
- [ ] **Not done.** Search and pagination past `limit: 50`, both named in the problem but not in the
      build list.

### 4. Relative timestamps

- [x] **Problem.** `lib/format.ts:9-18` pins `en-US` and UTC so server and client agree. That is the
      correct engineering decision with an unfriendly result: every date in the product reads
      `Sep 17, 2026, 2:03 PM UTC`, including "Created" on the list page where relative time is what
      people actually want.
- [x] **Files.** New `components/relative-time.tsx`; used from `app/(app)/jobs/page.tsx`,
      `app/(app)/evaluations/page.tsx`, and the timestamp rows in `app/(app)/jobs/[id]/page.tsx`.
- [x] **What to build.** Render the pinned UTC string on the server, upgrade to `4 minutes ago`
      after hydration with the local absolute time in `title=`. No hydration mismatch, because the
      first client render matches the server output before the effect runs.
- [x] **Keep.** `formatDateTime` stays for places where the exact instant matters, such as the Run
      metadata disclosure.
- [x] **Done when.** The jobs list reads in relative time and hovering still gives the exact
      instant.

### 5. Loading, error and not-found states

- [x] **Problem.** There is not one `loading.tsx`, `error.tsx` or `not-found.tsx` anywhere under
      `app/`. Every navigation into a database-reading page is a dead click until the server
      answers, and a database hiccup shows Next's default error screen. `components/ui/skeleton.tsx`
      exists and is imported by nothing.
- [x] **Files.** New `loading.tsx` for `/jobs`, `/jobs/[id]`, `/evaluations`, `/evaluations/[id]`
      and `/settings/github`. A shared `app/(app)/error.tsx`. A styled
      `app/(app)/jobs/[id]/     not-found.tsx` for the `notFound()` call at
      `app/(app)/jobs/[id]/page.tsx:41`.
- [x] **What to build.** Skeletons shaped like the real content, not generic grey bars: a table
      skeleton for the lists, a two-column card skeleton for the job detail.
- [x] **Done when.** Every route transition shows structure immediately, and a thrown database error
      shows a Rivet-styled page with a retry.

---

## Tier 2 - coherence pass

### 6. One disclosure component

- [ ] **Problem.** Nine raw `<details>` blocks hand-roll the same surface with copy-pasted classes
      and a literal `▾` text character as the chevron.
- [ ] **Where.** `app/(app)/jobs/[id]/page.tsx:157` and `:259`,
      `components/validation-panel.tsx:115` and `:157`, `components/execution-timeline.tsx:236` and
      `:485`, plus the rest.
- [ ] **What to build.** One `components/ui/disclosure.tsx` wrapping the pattern, with a lucide
      `ChevronDown` and a single rotation transition. Replace all nine call sites.
- [ ] **Done when.** Every collapsible section in the app opens the same way and
      `grep -c "<details"` over `app` and `components` returns 0 outside the new component.

### 7. Use the icon library that is already installed

- [ ] **Problem.** `lucide-react` is a dependency and its only import in the whole app is inside
      `components/ui/sonner.tsx`. Nav, status badges, timeline rows, empty states and buttons are
      all text-only.
- [ ] **What to build.** A restrained pass: status glyphs on `StatusBadge`, event-kind icons in the
      timeline, an external-link arrow on `ExternalLink`, icons on the four nav items, an icon in
      each empty state.
- [ ] **Watch out for.** Restraint is the point. One icon per row maximum, always paired with text,
      never as the only affordance.
- [ ] **Done when.** The timeline and the jobs list can be scanned without reading every word.

### 8. A link token instead of six hardcoded sky pairs

- [ ] **Problem.** `text-sky-700 dark:text-sky-300` is hardcoded in six places
      (`app/(app)/jobs/[id]/page.tsx:346`, `components/execution-timeline.tsx:342` and `:423`,
      `components/github/repository-picker.tsx:185`, and others). It is not a token, and it competes
      with the real accent, `--primary` (teal, `oklch(0.4 0.09 185)`), which the app shell barely
      uses outside buttons and one eight-pixel dot.
- [ ] **Files.** `app/globals.css` for the token, a new shared `ExternalLink` / `A` primitive, then
      every call site.
- [ ] **Decide first.** Is the accent teal or sky? Commit to one and make the other unused.
- [ ] **Done when.** No component spells a link color itself.

### 9. Collapse the status palette

- [ ] **Problem.** `lib/job-status.ts` spreads fourteen statuses across teal, sky, emerald, red,
      amber and orange. At twenty-pixel badge height teal, sky and emerald are nearly
      indistinguishable, and the teal/sky split (provisioning-analyzing-planning against
      implementing-testing-reviewing) encodes a distinction users have no mental model for.
- [ ] **What to build.** Three visual states: in progress (one accent plus motion), succeeded
      (green), needs attention (red or amber). Let the stepper from item 1 and the icon from item 7
      carry which phase it is.
- [ ] **Keep.** The `Record<JobStatus, StatusPresentation>` shape, which is what makes a fifteenth
      status break `pnpm typecheck` until somebody gives it a treatment.
- [ ] **Done when.** A glance at a badge answers good / bad / working, and the phase is read from
      the label rather than the hue.

### 10. Header: active state, identity, and a global create action

- [ ] **Problem.** In `app/(app)/layout.tsx:20-45` the four nav items render identically whatever
      page you are on, "Sign out" carries the same weight as a destination, nothing says who you are
      signed in as, and "New job" is only reachable from `/jobs`.
- [ ] **What to build.** Active-route styling on the nav. Sign out demoted into an avatar menu on
      the right showing the GitHub login. A primary "New job" button in the header.
- [ ] **Done when.** You always know where you are, who you are, and how to start a job.

### 11. Replace the footer

- [ ] **Problem.** `app/(app)/layout.tsx:51-56` puts release-notes prose in persistent chrome: "Jobs
      run with real sandbox provisioning, baseline testing, validation, and sandbox-backed coding
      agent sessions when the worker is configured for Pi."
- [ ] **What to build.** Either something useful (version, docs link, worker health) or nothing.

### 12. Theme toggle

- [ ] **Problem.** `app/layout.tsx:44` follows the OS only, by explicit design. The reasoning in
      that comment is sound, but users expect the control and dark is the stronger of the two
      palettes.
- [ ] **What to build.** A three-way toggle (system / light / dark) writing to `localStorage`, read
      by the existing inline pre-paint script. Keep the script inline and keep every page a server
      component - that is what the current design buys and it should survive.

---

## Tier 3 - page-specific

### 13. New job form

- [ ] In picker mode the **Repository URL** field still renders as a read-only input
      (`components/new-job-form.tsx:238`). It restates what the picker already shows. Collapse it to
      a line of text.
- [ ] The GitHub picker sits in a `rounded-xl border` box while every other field is bare, so the
      form has two visual grammars. Pick one.
- [ ] Submit is a default-size `Button` (`h-8`) for the action that spends real money and takes
      minutes. Make it `lg`, full-width on mobile, and add the ⌘↵ hint.
- [ ] Nothing sets expectations. Add "this typically takes N minutes and costs about $X" from
      `maxDurationSeconds` and `maxCostUsd`, which are known before submit.
- [ ] The picker's loading state is a bare sentence at
      `components/github/repository-picker.tsx:170`. Use skeleton selects.

### 14. Validation panel on mobile

- [ ] `components/validation-panel.tsx:80` hides the middle column (`12/14 passed`) below `sm:`.
      That is the most important number in the panel and phones lose it entirely. Reflow it under
      the check name instead of hiding it.

### 15. Tables on mobile

- [ ] `/jobs` and `/evaluations` render four and five column tables with no responsive fallback.
      They overflow or crush on a phone. Add a card-list layout below `sm:`.

### 16. Job section nav

- [ ] `app/(app)/jobs/[id]/page.tsx:314` is a horizontally scrollable pill bar with no scroll
      affordance and no active-section highlight. Add scroll-snap plus an `IntersectionObserver`
      active state, or convert to real tabs.

### 17. Inline code has no styling

- [ ] `app/(app)/evaluations/page.tsx:63` tells the user to run `pnpm eval:run` inside a `<code>`
      element that renders as plain body text. Give inline code a token and apply it everywhere.

### 18. Landing page CTA

- [ ] `app/(public)/page.tsx` is the strongest-designed surface in the repo. One problem: the
      primary CTA is "Sign in", a dead end for everyone who is not the configured owner. Lead with
      "See a run" and demote sign-in to the ghost button.

---

## Tier 4 - motion

`motion` is a dependency used in exactly three files: `components/execution-timeline.tsx`,
`components/job-live/live-status-badge.tsx` and `components/job-live/job-live-provider.tsx`.
Everything already respects `prefers-reduced-motion` through `timelineMotion.reduceMotion`, so
extending it is safe.

- [ ] Animate the stepper from item 1 advancing between phases. This is the marquee moment of the
      whole product and deserves the most attention.
- [ ] Count up the live token and cost numbers in `components/job-live/live-agent-usage.tsx` instead
      of swapping them hard.
- [ ] Give `components/cancel-job-button.tsx` optimistic state rather than only a label change.
- [ ] Add `view-transition-name` on the job title so the list to detail navigation is continuous.

---

## Suggested order

1, 2, 5, 3, 4 first - those five change how the product feels to operate. Then Tier 2 as a single
consistency pass. Tier 3 and 4 as you touch the pages.
