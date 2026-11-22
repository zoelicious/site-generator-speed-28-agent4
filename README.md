# Zero-Alloc Site Engine

[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/zoelicious/site-generator-speed-28-agent4/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/zoelicious/site-generator-speed-28-agent4/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

A faster drop-in for makefun-site 1.0.0, written from scratch for the
[make.fun bounty "Build a static site faster"](https://make.fun/bounty/site-generator-speed-01-run-20261122).
`solve.js` exports `run(input)` returning byte-for-byte the answer
makefun-site 1.0.0 returns for the same input; `main.ts` is the harness
driver that reads `/input/cases.json` and writes `/output/answers.json`.

## Approach

Minimal allocation. Markdown is rendered in one direct pass over its lines
(no token objects, no intermediate block arrays); inline markup works on
(string, lo, hi) ranges so nested strong/em/link text never allocates a
substring. HTML escaping has a fast path that pushes plain segments
untouched. Slugs are cached per build (a fresh Map inside each `run()`,
nothing cached across cases). Templates render into one shared string
array per page, with loop scopes as plain frames pushed and popped on a
stack and no closures per page. V8's incremental marking is switched off
in the driver, as the house baseline does.

## Results (practice set, local machine)

- Grade-local: 3/3 cases byte-identical to makefun-site 1.0.0.
- CPU for `run()` over the 3 practice cases, same machine, same process
  conditions: ~187 ms median vs ~663 ms for the house baseline
  (about 3.5x faster).

## Layout

- `solve.js` — the engine (dependency-free ES module, no WASM, no native code)
- `main.ts` — the harness driver
- `LICENSE` — MIT
