# Contributing

## Setup

```bash
npm install
npm run build:contract   # artifacts/ (git-ignored); the tests need the ABI
npm test
npm run build            # extension/dist
```

Chrome 114 or newer, the version the side panel API appeared in.

Load `extension/` unpacked in `chrome://extensions`. After a rebuild press the
reload arrow on the extension card and reload the FOMO tab; the popup shows a
banner when a tab runs an older bundle than the extension.

`npm run watch` rebuilds on change with inline source maps; `npm run build`
is the release build, without them (`node build.mjs --dev` gives a one-off
build with maps). `npm run ext` builds and syncs into a separate folder Chrome
has loaded (see the script header) and stamps the version so you can tell
which build a tab runs. Every build writes its stamp to `extension/dist/build.json`,
and a running extension reloads itself when the stamp on disk changes.

A release build is reproducible: with `SOURCE_DATE_EPOCH` set, or with a clean
git tree, the stamp is that time rather than the wall clock, and two builds of
the same commit are byte-identical (`test/build-reproducible.test.mjs` checks
it; `LIMIL_OUTDIR` points a build elsewhere). A dirty tree, `--watch` or `--dev`
stamp the wall clock, so a rebuild is always seen as new while developing.

## Layout

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). The rule of thumb: logic
goes in `src/shared/` with a test; the three worlds only wire things up.

## Tests

`node --test "test/**/*.test.mjs"`. Tests are pure and offline. The two EVM
suites (`session-account`, `output-guard-evm`) execute the compiled contracts
on `@ethereumjs/vm`; they are the slow half of the run, and they run the
bytecode that is live on chain.

When you touch the contracts, keep the deployed bytecode in mind: a change to
`LimilSessionAccount` means every wallet re-delegates on its next order, a
change to `LimilOutputGuard` changes its CREATE2 address.

## Conventions

- English everywhere: code, comments, tests, journal lines. Interface strings
  live in `src/locales/en.js` and must exist in every other dictionary
  (`test/i18n.test.mjs` enforces parity).
- Messages that a person reads should say what happened and why, in words. A
  bare "failed" costs someone an evening.
- Anything that can sign or send has a test for what it must refuse, not only
  for what it allows.
- Anything third-party ships with its license: the fonts under
  `extension/licenses/`, everything listed in `THIRD_PARTY_NOTICES.md`.
- The deployed contracts' sources (`contracts/*.sol`) are byte-frozen, comments
  included: a changed byte is a changed address. They are the one place the
  wording rules above do not reach.
- No secrets in the tree. `secrets/`, `auth.json`, `.env` and `artifacts/` are
  ignored; keep it that way.

## Pull requests

Small and focused. Say what changed, why, and how you checked it. If the
change touches execution, include the journal lines from a live or simulated
run.
