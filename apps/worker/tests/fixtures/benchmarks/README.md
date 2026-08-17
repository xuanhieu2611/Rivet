# Suite-owned benchmark cases

Two benchmark cases that belong to the worker test suites, not to the corpus in `benchmarks/` at the
repository root.

They live here for one reason. The five real cases are **content**: they will keep being edited, and
their hidden tests will keep being improved as the harness learns what they should have encoded. A
test of the harness that breaks when a hidden test is improved is a test that teaches people to stop
improving hidden tests. So acceptance runs A-G use these two, which change only when the harness's
requirements change.

- `fixture-pass` - one seeded bug, a public test suite that stays green over it, and a hidden test
  covering the boundary the public suite does not. It also carries a binary file, which is what run
  B's byte-for-byte and `._*` assertions are made of.
- `fixture-partial` - a public suite that goes green on the obvious implementation, and a hidden
  test encoding a rule stated only in the issue text. This is what makes run D's second arm
  expressible: a job that passes every check Rivet can run and is still wrong.

Both carry a distinctive sentinel string in `hidden/`, which is what turns run C - "the hidden tests
are nowhere" - into a grep rather than an argument.

Deliberately not under `tests/sandbox/fixtures/`, where the git-daemon repository fixture lives:
both the integration and the sandbox suite read these, and a fixture owned by one suite that another
imports is how a test directory starts depending on its neighbours.
