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

**Done.** All seven shipped together. Two items asked for a decision first and got one: the accent
is **teal** (`--primary`), and the footer carries version, docs and source rather than nothing.

### 6. One disclosure component

- [x] **Problem.** Nine raw `<details>` blocks hand-rolled the same surface with copy-pasted classes
      and a literal `▾` text character as the chevron.
- [x] **Where.** `app/(app)/jobs/[id]/page.tsx:157` and `:259`,
      `components/validation-panel.tsx:115` and `:157`, `components/execution-timeline.tsx:236` and
      `:485`, plus the rest.
- [x] **What to build.** One `components/ui/disclosure.tsx` wrapping the pattern, with a lucide
      `ChevronDown` and a single rotation transition. Replace all nine call sites.
- [x] **Done when.** Every collapsible section in the app opens the same way and
      `grep -c "<details"` over `app` and `components` returns 0 outside the new component.
- [x] **Built as.** `components/ui/disclosure.tsx`, with a `trailing` slot because the chevron is
      not always last in the summary row - a command header ends with an outcome and a duration, a
      file diff with its insertion counts, and those sit in the same flex group as the chevron
      rather than in the summary. The grep is a test rather than a thing to remember:
      `components/ui/disclosure.test.ts` walks every `.ts`/`.tsx` under `app` and `components` and
      fails on any authored `<details`.

### 7. Use the icon library that is already installed

- [x] **Problem.** `lucide-react` is a dependency and its only import in the whole app is inside
      `components/ui/sonner.tsx`. Nav, status badges, timeline rows, empty states and buttons are
      all text-only.
- [x] **What to build.** A restrained pass: status glyphs on `StatusBadge`, event-kind icons in the
      timeline, an external-link arrow on `ExternalLink`, icons on the four nav items, an icon in
      each empty state.
- [x] **Watch out for.** Restraint is the point. One icon per row maximum, always paired with text,
      never as the only affordance.
- [x] **Done when.** The timeline and the jobs list can be scanned without reading every word.
- [x] **Built as.** `JOB_EVENT_MARKER` replaces `JOB_EVENT_TONE` as the authored record - still a
      total `Record<JobEventType, ...>`, now carrying a glyph alongside two colour literals, with
      `JOB_EVENT_TONE` derived from it so a new event type still breaks `pnpm typecheck` until
      somebody decides how it reads. `JOB_STATUS_PRESENTATION` grew an `icon`. Both colours are
      literals rather than a runtime `bg-` to `text-` rewrite, because Tailwind scans source and
      would never generate a class it has not seen. The nav's labels are `sr-only sm:not-sr-only`
      rather than `hidden sm:inline`: a nav that collapses to bare glyphs on a phone leaves the link
      with no accessible name at all.
- [x] **Also.** `components/empty-state.tsx` replaces the dashed box three pages spelled themselves.

### 8. A link token instead of six hardcoded sky pairs

- [x] **Problem.** `text-sky-700 dark:text-sky-300` is hardcoded in six places
      (`app/(app)/jobs/[id]/page.tsx:346`, `components/execution-timeline.tsx:342` and `:423`,
      `components/github/repository-picker.tsx:185`, and others). It is not a token, and it competes
      with the real accent, `--primary` (teal, `oklch(0.4 0.09 185)`), which the app shell barely
      uses outside buttons and one eight-pixel dot.
- [x] **Files.** `app/globals.css` for the token, a new shared `ExternalLink` / `A` primitive, then
      every call site.
- [x] **Decide first.** Is the accent teal or sky? Commit to one and make the other unused.
- [x] **Decided.** Teal. `--link: var(--primary)` and `--progress: var(--primary)` are the two new
      tokens; sky survives only in `components/diff-viewer/`, where it is syntax colour for hunk
      headers rather than accent.
- [x] **Done when.** No component spells a link color itself.
- [x] **Built as.** `components/ui/link.tsx` exports `AppLink` (in-app, `next/link`), `ExternalLink`
      (leaves Rivet, carries the arrow from item 7) and `AnchorLink` (same page). A test in
      `lib/job-status.test.ts` fails on any `sky-` or `teal-` literal reaching a timeline marker.

### 9. Collapse the status palette

- [x] **Problem.** `lib/job-status.ts` spreads fourteen statuses across teal, sky, emerald, red,
      amber and orange. At twenty-pixel badge height teal, sky and emerald are nearly
      indistinguishable, and the teal/sky split (provisioning-analyzing-planning against
      implementing-testing-reviewing) encodes a distinction users have no mental model for.
- [x] **What to build.** Three visual states: in progress (one accent plus motion), succeeded
      (green), needs attention (red or amber). Let the stepper from item 1 and the icon from item 7
      carry which phase it is.
- [x] **Keep.** The `Record<JobStatus, StatusPresentation>` shape, which is what makes a fifteenth
      status break `pnpm typecheck` until somebody gives it a treatment.
- [x] **Done when.** A glance at a badge answers good / bad / working, and the phase is read from
      the label rather than the hue.
- [x] **Built as.** A `StatusTone` of `idle | progress | success | attention`, with the fourteen
      statuses mapping onto four surfaces in `STATUS_TONE_CLASSNAME` and the badge deriving its
      classes from the tone rather than spelling them. `failed`, `budget_exceeded` and `timed_out`
      all read as `attention`: they differ in cause, not in what the reader should do, and the label
      already says which. Amber left the status palette entirely. Motion is `animate-pulse` on the
      progress glyph, with `motion-reduce:animate-none`. A test asserts the surface count is four,
      so a reviewer reaching for a fifth hue fails `pnpm test` rather than review.

### 10. Header: active state, identity, and a global create action

- [x] **Problem.** In `app/(app)/layout.tsx:20-45` the four nav items render identically whatever
      page you are on, "Sign out" carries the same weight as a destination, nothing says who you are
      signed in as, and "New job" is only reachable from `/jobs`.
- [x] **What to build.** Active-route styling on the nav. Sign out demoted into an avatar menu on
      the right showing the GitHub login. A primary "New job" button in the header.
- [x] **Done when.** You always know where you are, who you are, and how to start a job.
- [x] **Built as.** `components/app-nav.tsx` is the only client code in the shell, and it is client
      code for exactly one reason: `usePathname`. `readPageSessionLogin()` in
      `lib/auth/page-guard.ts` supplies the login and is presentation only - it re-runs the same
      owner comparison rather than trusting the signature, and returns `null` under `RIVET_AUTH=off`
      so the header shows nothing rather than claiming an identity. `components/account-menu.tsx`
      keeps sign out a real form POST, because the route answers 303 with the expired cookie on the
      redirect response.

### 11. Replace the footer

- [x] **Problem.** `app/(app)/layout.tsx:51-56` puts release-notes prose in persistent chrome: "Jobs
      run with real sandbox provisioning, baseline testing, validation, and sandbox-backed coding
      agent sessions when the worker is configured for Pi."
- [x] **What to build.** Either something useful (version, docs link, worker health) or nothing.
- [x] **Built as.** `lib/app-chrome.ts`, a pure function of an env object with no Next.js import and
      no database read, giving `RIVET_SERVICE_VERSION` (the same value that becomes
      `service.version` on every span), a docs link and a source link. Worker health was left out:
      the footer is on every page, and a persistent liveness probe is a query per render for a fact
      the job pages already answer.

### 12. Theme toggle

- [x] **Problem.** `app/layout.tsx:44` follows the OS only, by explicit design. The reasoning in
      that comment is sound, but users expect the control and dark is the stronger of the two
      palettes.
- [x] **What to build.** A three-way toggle (system / light / dark) writing to `localStorage`, read
      by the existing inline pre-paint script. Keep the script inline and keep every page a server
      component - that is what the current design buys and it should survive.
- [x] **Built as.** `lib/theme.ts` holds the script as a string and is the only place the decision
      is made; the script installs a setter and `components/theme-toggle.tsx` calls it, so nothing
      else ever touches the `dark` class. The current preference is read back off `data-theme` after
      hydration rather than serialized into the server's HTML, which is what keeps a per-viewer
      preference out of a server component's output. Every `localStorage` access is wrapped - a
      private window makes the accessor throw, and falling through to the OS is the right answer
      there anyway.

---

## Tier 3 - page-specific

**Done.** All six shipped together. Item 13's fourth bullet asked for an estimate and got a ceiling
instead; the note under it says why.

### 13. New job form

- [x] In picker mode the **Repository URL** field still renders as a read-only input
      (`components/new-job-form.tsx:238`). It restates what the picker already shows. Collapse it to
      a line of text.
- [x] The GitHub picker sits in a `rounded-xl border` box while every other field is bare, so the
      form has two visual grammars. Pick one.
- [x] Submit is a default-size `Button` (`h-8`) for the action that spends real money and takes
      minutes. Make it `lg`, full-width on mobile, and add the ⌘↵ hint.
- [x] Nothing sets expectations. Add "this typically takes N minutes and costs about $X" from
      `maxDurationSeconds` and `maxCostUsd`, which are known before submit.
- [x] The picker's loading state is a bare sentence at
      `components/github/repository-picker.tsx:170`. Use skeleton selects.
- [x] **Built as.** The URL line keeps a hidden input behind it, because `repoUrl` is still what
      gets posted; the picker lost its box and became a `<section>` with a heading, the same stacked
      label-and-control as every other field. ⌘↵ actually submits - the description is a textarea,
      so a plain Enter belongs to it - and the hint renders null until an effect reads the platform,
      which is a frame of nothing rather than "Ctrl" swapped for "⌘" after hydration.
- [x] **Ceilings, not estimates.** `maxDurationSeconds` and `maxCostUsd` are not known before
      submit: they are Postgres column defaults, invisible to anything that has not inserted a row.
      `JOB_BUDGET_DEFAULTS` in `packages/contracts/src/job.ts` mirrors them so a browser can name
      one without importing `pg`, and `job.test.ts` reads the real column defaults and fails on
      drift - the same arrangement the status enum has. The form states where a run stops rather
      than guessing what it will take, because a first-run median this product does not have yet
      would be a number invented to fill a sentence.

### 14. Validation panel on mobile

- [x] `components/validation-panel.tsx:80` hides the middle column (`12/14 passed`) below `sm:`.
      That is the most important number in the panel and phones lose it entirely. Reflow it under
      the check name instead of hiding it.
- [x] **Built as.** Explicit grid placement on all three cells rather than a second stacked layout:
      the count moves to row 2 below `sm` while the outcome badge stays pinned to row 1, which is
      the one arrangement a two-column fallback cannot express by auto-placement alone.

### 15. Tables on mobile

- [x] `/jobs` and `/evaluations` render four and five column tables with no responsive fallback.
      They overflow or crush on a phone. Add a card-list layout below `sm:`.
- [x] **Built as.** Both pages render the table `hidden sm:block` and a card list `sm:hidden` from
      the same array, so the two layouts cannot disagree about what is in them. `/jobs` factored its
      pulse, badge and phase hint into one `JobStatusCell` that both branches call, because that
      trio is the part most likely to drift.

### 16. Job section nav

- [x] `app/(app)/jobs/[id]/page.tsx:314` is a horizontally scrollable pill bar with no scroll
      affordance and no active-section highlight. Add scroll-snap plus an `IntersectionObserver`
      active state, or convert to real tabs.
- [x] **Built as.** `components/job-section-nav.tsx` (client, for `IntersectionObserver`) over
      `lib/job-sections.ts`, which holds the section list and `activeSectionId` - the tie-break rule
      when several panels are in the band at once is document order, and it is a unit test rather
      than a comment. The bar became sticky under the header, which is what makes an active
      highlight worth having, so every section's `scroll-mt` moved to `scroll-mt-32` to clear both.
      The right-edge fade is measured (`scrollWidth` against `clientWidth`) rather than always on:
      six pills fit on a laptop, and a fade over a bar with nothing past its edge promises content
      that is not there. The links stay ordinary `<a>` fragments, so the nav still navigates with
      JavaScript off.

### 17. Inline code has no styling

- [x] `app/(app)/evaluations/page.tsx:63` tells the user to run `pnpm eval:run` inside a `<code>`
      element that renders as plain body text. Give inline code a token and apply it everywhere.
- [x] **Built as.** `--code` / `--code-foreground` in `app/globals.css` and
      `components/ui/inline-code.tsx`. Applied to code _in prose_ - the evaluations empty state, the
      `GITHUB_APP_SLUG` mention on the GitHub settings page, the reviewer's path pills, and the
      keyboard hint on the create form. Deliberately **not** applied to the timeline's argv rows,
      the command log or the diff viewer's file paths: those are code cells that own their surface
      already, and wrapping them would put a pill inside a pill.

### 18. Landing page CTA

- [x] `app/(public)/page.tsx` is the strongest-designed surface in the repo. One problem: the
      primary CTA is "Sign in", a dead end for everyone who is not the configured owner. Lead with
      "See a run" and demote sign-in to the ghost button.
- [x] **Built as.** The hero pair swapped. The footer's sign-in stays primary, because by the time a
      reader is there they have been shown the run and sign-in is the only thing left to offer.

---

## Tier 4 - motion

**Done.** All four shipped together. The one item that could not be built the way it was written is
the last: Next 16 ships no router integration for view transitions, so Rivet drives the API itself
from one link component, and the note under it says what that costs.

`motion` was a dependency used in exactly three files: `components/execution-timeline.tsx`,
`components/job-live/live-status-badge.tsx` and `components/job-live/job-live-provider.tsx`.
Everything already respected `prefers-reduced-motion` through `timelineMotion.reduceMotion`, so
extending it was safe - every item below reads the same flag rather than inventing a second one.

### 19. The stepper advancing

- [x] Animate the stepper from item 1 advancing between phases. This is the marquee moment of the
      whole product and deserves the most attention.
- [x] **Built as.** Three changes in `components/job-live/phase-stepper.tsx`, and the first is the
      one that matters: every fill is now `initial={false}` and pending segments render at width
      `0%` rather than not rendering at all. The old version replayed the whole run on every load -
      opening a job four phases in animated four bars filling from zero, which is exactly what
      progress looks like, so a page refresh was indistinguishable from the pipeline moving. Now
      mount is still and only an advance that happens while somebody is watching moves. The advance
      itself is sequenced: the completing segment fills to 100% immediately and the newly active one
      waits `SEGMENT_HANDOFF_DELAY` before starting, so it reads left to right as a handoff instead
      of the whole bar twitching at once. The delay costs nothing on load precisely because mount is
      not animated.
- [x] **Also.** The active segment's opacity throb became a highlight sweeping along the fill. A
      pulse on a four-pixel bar is barely visible and reads as a rendering glitch; a sweep says work
      is moving through here and points the direction the stepper advances. It lives **inside** the
      fill element, because over the unfilled remainder it would draw progress that has not
      happened. Its colour is `--primary-foreground`, which is by definition what stays legible on
      `--primary` in both themes. The phase word and the `4 of 7` count roll upward through one
      shared `Swap`, in `popLayout` rather than `wait` - emptying the box between two words makes
      the text after it jump left.

### 20. Counting up the live usage numbers

- [x] Count up the live token and cost numbers in `components/job-live/live-agent-usage.tsx` instead
      of swapping them hard.
- [x] **Built as.** `lib/count-up.ts` holds the tween and is unit tested; `components/count-up.tsx`
      holds the twenty lines of `requestAnimationFrame` that are not. The first render returns the
      value unchanged, which is what keeps it safe inside a server-rendered tree: the server prints
      the persisted total, the browser's first pass prints the same total, and only a change
      arriving after hydration animates. Counting up from zero on load would replay a whole run's
      spend as if it were happening now - the same mistake the stepper used to make, one component
      over.
- [x] **Duration scales with the share of the number that changed**, not with the delta. 40 tokens
      onto 20 is the whole counter moving and gets the full sweep; 40 tokens onto 400,000 is a
      rounding error and lands almost immediately. A fixed duration leaves the header permanently
      mid-tween on a long run.
- [x] **Cost is counted as a number and reformatted per frame**, never interpolated as a string. The
      persisted total is `numeric(10,4)`, so every frame keeps all four places; an unpriced turn
      still renders `unpriced` and is not animated at all, because there is no number there.

### 21. Optimistic cancellation

- [x] Give `components/cancel-job-button.tsx` optimistic state rather than only a label change.
- [x] **Built as.** A four-state control - `idle`, `cancelling`, `requested`, `cancelled` - behind
      `useOptimistic` and an async `useTransition`, with an icon and a rolling label per state.
      `requested` is why it is a state rather than a boolean: `202` means a worker has been asked to
      stop and has not stopped yet, so the button must neither claim success nor offer the action
      again. `useOptimistic` rather than a `pending` flag because the two differ exactly where it
      matters - a flag has to be cleared by hand on every exit path and the failing path is the one
      that gets forgotten, while React drops the optimistic value when the transition settles, so a
      request that never reached the server puts the action back by itself.
- [x] **Also.** The page passes `cancelRequested` from `jobs.cancel_requested_at`, so a reload of a
      job whose cancellation is already in flight opens with the committed state rather than
      re-offering a button that would answer `409`.

### 22. A continuous job title

- [x] Add `view-transition-name` on the job title so the list to detail navigation is continuous.
- [x] **Built as.** `lib/view-transition.ts` (the decisions, unit tested) plus
      `components/job-title-link.tsx` (the DOM). Next 16 ships no router integration for this - its
      config has no view-transition flag and the stable React build exports no `<ViewTransition>` -
      so the one navigation worth animating opts in by hand: the link intercepts a plain left click,
      applies the name imperatively, and resolves `startViewTransition`'s update callback when the
      router commits. Imperatively because `startViewTransition` captures the DOM the moment it is
      called and a React state update would not have landed yet.
- [x] **The name is shared, not per job.** A view transition requires each name to be unique within
      the old document and within the new one, so only the clicked row wears it; fifty per-job names
      would make every row a separate snapshot layer for a transition that morphs exactly one.
- [x] **The skeleton is the frame it lands on.** `app/(app)/jobs/[id]/loading.tsx` from item 5
      renders as soon as the route commits, so its title placeholder carries the same name - without
      that, the morph would have nothing to morph into and would simply drop the title.
- [x] **Everything about it is additive.** Reduced motion, a browser without the API, a modified
      click or no JavaScript at all leave an ordinary `next/link`, and the update callback has an
      800ms ceiling because the page is frozen on its old snapshot until it settles: a stalled
      navigation must arrive late rather than freeze the product.
- [ ] **Not done.** The mobile card list navigates without the morph. Its whole card is the link, so
      the title cannot be a second anchor inside it, and restructuring the card to make the title
      the only tap target would trade a real affordance for an animation.

---

## Suggested order

1, 2, 5, 3, 4 first - those five change how the product feels to operate. Then Tier 2 as a single
consistency pass. Tier 3 and 4 as you touch the pages.

All four tiers are done. What is left is named in the backlog rather than here: search and
pagination past `limit: 50` under item 3, and the mobile card list's missing title morph under
item 22.
