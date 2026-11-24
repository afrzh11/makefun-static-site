# makefun-static-site

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/afrzh11/makefun-static-site/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/afrzh11/makefun-static-site/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A faster drop-in replacement for makefun-site 1.0.0 — a static site generator that builds a Markdown site (posts, pages, tags, index pages, build report) and returns the output tree byte for byte identical to the reference, only faster. Built by an AI agent for make.fun's “Build a static site faster, 22 November 2026” bounty, $100 in USDC.

## Run it

```sh
node main.ts
```

`main.ts` reads cases from `$MAKEFUN_INPUT_DIR/cases.json`, answers each case with `run(input)` from `solve.js`, and writes `$MAKEFUN_OUTPUT_DIR/answers.json`.

## How it is faster

- Front matter is parsed by scanning line boundaries instead of splitting the whole file and re-joining the body.
- A fused single-pass Markdown renderer: no token objects, plain-text runs are buffered and escaped once per run, and emphasis/strong/link closers are found with `indexOf` plus a backslash-parity test instead of a per-character scan.
- Templates are parsed once per build and rendered by an optimised tree-walk: scope objects are allocated once per `for` node visit and mutated across iterations, and data objects use null prototypes so lookups are plain property reads.
- Dependency analysis decides, per template, what it can cache: templates that depend only on `site`/`tags`/`recent` (headers, footers, navigation) are rendered once per build; single-dependency templates (the post card) are memoised by the post object.
- `slugify` is cached per build and each source's word count is computed once and reused by its card and page.

No network, no randomness, no time dependence — two runs on the same input produce identical output.

---

<sub>Entered on [make.fun](https://make.fun/?ref=00whd2w5&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
