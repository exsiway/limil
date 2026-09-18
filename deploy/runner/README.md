# deploy/runner

Compose stack for running the extension on a server: the hub (the `daemon`
service) and a Chromium with the extension preloaded, the runner browser,
behind a browser-based desktop (noVNC). Full walkthrough in
`docs/SERVER-SETUP.md`, security included;
the short version:

```bash
# in the repository root: build the extension in a throwaway Node container
# (no Node on the host). The default is the newest release tag whose signature
# verifies against deploy/allowed_signers; see scripts/update.sh for the two
# modes, and pass LIMIL_UPDATE_MODE=main only if you mean to follow the branch
# with nothing checked.
bash scripts/update.sh --force
cd deploy/runner && cp .env.example .env && $EDITOR .env
docker compose up -d --build
ssh -L 3001:127.0.0.1:3001 user@server  # then open https://localhost:3001
```

Log in to FOMO in the Chromium window with the same account as on the laptop,
open a token page and leave the tab open. Pair that browser with the hub from a
shell with `scripts/pair-runner.sh` (the laptop's popup shows the exact
command), or by hand in its popup. The profile lives in the `runner-config`
volume and survives restarts.

The image is `linuxserver/chromium`, which documents `CHROME_CLI` for extra
flags; the extension is loaded through it. If `--load-extension` stops being
honoured by a future Chromium, load the folder once by hand through
`chrome://extensions` (`/config/extension`); the profile keeps it.
