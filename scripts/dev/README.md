# Dev harnesses (not part of the build or the tests)

Two things that need a browser and cannot run under `npm test`.

## panel-e2e.mjs

The side panel against a real Chromium with the extension loaded: a
logged-out fomo.family tab gets a synthetic block (four tab buttons, a
virtualised card list with STALE tops, FOMO-shaped token rows, a hostile
image), the panel page is opened as a tab, and the script checks the
mirror, the deltas, the flow layout, the buy/sell presses, the forwarded
wheel scroll, the fonts, the awake switch and the tab's honesty after the
panel closes.

Needs Playwright's Chromium (branded Chrome 137+ ignores --load-extension)
and playwright-core:

    PLAYWRIGHT_CORE=/path/to/playwright-core/index.mjs \
    BIN=~/Library/Caches/ms-playwright/chromium-1117/chrome-mac/Chromium.app/Contents/MacOS/Chromium \
    EXT=$PWD/extension PROFILE=/tmp/limil-pw-profile SHOT=/tmp/panel.png \
    node scripts/dev/panel-e2e.mjs

Remove PROFILE between runs. Playwright pages count as visible: the
hidden-tab behaviour (no frames, no scroll events) cannot be tested here.

## legend-stand/

FOMO's list library (`@legendapp/list`, the `react` entry) on its own, in
the fixed-row-height mode FOMO uses for the Tokens tab, with
`isolated/token-list.js` bundled in. `probe.mjs` scrolls it and checks
that the rows placed by the extension cover the viewport at every position.

    cd scripts/dev/legend-stand
    npm init -y && npm i react@19 react-dom@19 react-native-web @legendapp/list esbuild
    node_modules/.bin/esbuild app.jsx --bundle --outfile=bundle.js --format=iife \
      --define:process.env.NODE_ENV='"production"' --define:__DEV__=false --jsx=automatic
    node_modules/.bin/esbuild ../../../src/isolated/token-list.js --bundle --outfile=token-list.js --format=iife --global-name=tokenList
    PLAYWRIGHT_CORE=... BIN=... node probe.mjs
