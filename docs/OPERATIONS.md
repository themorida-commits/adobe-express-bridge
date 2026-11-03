# Operations notes

Hard-won operational facts from running this bridge in production (v1.1, verified live in Adobe Express).

## Relay addressing

- The relay base URL must be `https://localhost:8322`, **not** `127.0.0.1` — the TLS certificate's SAN covers only `localhost`; requests to `127.0.0.1` fail TLS validation silently (empty reply).

## Protocol

- Enqueue: `POST /enqueue {"id","type","params"}` → `{"queued": id}`
- Panel poll: `GET /poll` → next queued command (or `null`)
- Result post-back: `POST /result` with `{id, ok, data}`; a `pngBase64` field is written to `relay/shots/<id>.png` and stripped from the stored result.
- Read a result: `GET /result/:id` → the stored result, or `{"pending": true}`.
- All endpoints except `/health` require the `x-bridge-token` header.
- The relay queue is **in-memory**: restarting the relay drops queued commands. That is acceptable for tests, not for unattended production batches.

## Command routing

- The panel (`addon/src/index.js`) only routes command types listed in its `SANDBOX_CMDS` set, plus `exportPage`, which runs on the UI side. Adding a sandbox command means: implement it in `addon/src/sandbox/code.js`, add its name to `SANDBOX_CMDS`, and redeploy the panel **with the token substituted** (see README → Setup).

## Deployment

- The add-on dev server (`npm run start` in `addon/`) rebuilds automatically on source changes (~seconds).
- Panel instances **cache their build**: after deploying sandbox/panel changes, relaunch the panel in Express ("Test your local add-on") or it keeps serving the old code. A `ping` result returning `pageWidth`/`pageHeight` identifies the current build.
- Token substitution for the panel (the panel source ships with the `__BRIDGE_TOKEN__` placeholder):

  ```bash
  sed "s/__BRIDGE_TOKEN__/$(cat relay/token.txt)/" addon/src/index.js
  ```

  (Apply to your working copy / build input, not to the committed source.)
