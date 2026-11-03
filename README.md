# adobe-express-bridge

A local bridge that lets an AI agent drive **Adobe Express** documents programmatically — no official API required.

```
┌─────────┐   POST /enqueue    ┌──────────────┐   GET /poll    ┌───────────────┐
│  Agent  │ ─────────────────▶ │ Relay        │ ◀───────────── │ Add-on panel  │
│ (yours) │ ◀───────────────── │ HTTPS        │ ─────────────▶ │ (iframe in    │
└─────────┘   GET /result/:id  │ localhost    │  POST /result  │  Express)     │
                               │ :8322        │                └──────┬────────┘
                               └──────────────┘                       │ apiProxy
                                                               ┌──────▼────────┐
                                                               │ Document      │
                                                               │ sandbox       │
                                                               └───────────────┘
```

## Why this exists

Adobe's hosted MCP server for Express rejects third-party OAuth redirect URIs, so an external agent cannot connect to Express through the official hosted route. Adobe Express **add-ons**, however, run inside the product with a full document SDK. This project turns a local add-on into a bridge:

1. Your agent enqueues a JSON command (`ping`, `addText`, `addRect`, `exportPage`, …) to a tiny zero-dependency HTTPS relay on `localhost:8322`.
2. The add-on **panel** (running inside Express) polls the relay, executes the command against the live document through the add-on **document sandbox**, and posts the result back.
3. Your agent reads the result — including a PNG rendition of the page, saved by the relay to `relay/shots/`.

The whole loop is local: nothing leaves your machine except Adobe Express itself. Verified end-to-end in production (v1.1), including frame-checked Persian (RTL) text rendering — see the findings below.

## Components

| Path | What |
|---|---|
| `relay/relay.mjs` | Zero-dependency Node HTTPS relay: command queue, token auth, result store, PNG shot writer. |
| `addon/` | An Adobe Express add-on scaffolded with `@adobe/ccweb-add-on-scripts` (`^3.11.0`). |
| `addon/src/index.js` | Panel side: polls the relay, routes commands, handles `exportPage` via the UI SDK. |
| `addon/src/sandbox/code.js` | Document sandbox: `ping`, `addRect`, `addText`, `listFonts`, plus the `probeText*` diagnostics that mapped the real text-styling API. |
| `docs/OPERATIONS.md` | Operational protocol and deployment notes. |

## Commands

| Command | Side | Notes |
|---|---|---|
| `ping` | sandbox | Liveness + page size (`pageWidth`/`pageHeight`). |
| `addRect` | sandbox | `{x, y, width, height, fill}` hex fill. |
| `addText` | sandbox | `{text, x, y, size, color, fontFamily, width}` — styling and RTL wrapping built in (see findings). |
| `listFonts` | sandbox | Diagnostic only — font enumeration is broken in this SDK version (see Limitations). |
| `probeText` … `probeText5` | sandbox | Diagnostics that introspect a live text node; keep them when extending the bridge. |
| `exportPage` | panel (UI SDK) | Renders the current page to PNG (`export` intent) and returns it to the relay as base64. |

## Setup

Prerequisites: Node.js 18+, an Adobe account with Express access, and a registered add-on in the [Adobe Developer Console](https://developer.adobe.com/console) (the add-on scaffold gives you a `testId`).

1. **Point the manifest at your add-on.** Replace `YOUR_ADDON_TEST_ID` in `addon/src/manifest.json` with the `testId` of your own registered add-on.

2. **Create the bridge token.**

   ```bash
   openssl rand -hex 24 > relay/token.txt
   ```

3. **Create a localhost TLS certificate** for the relay. Its SAN must cover `localhost` (not `127.0.0.1`):

   ```bash
   openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
     -keyout relay/key.pem -out relay/cert.pem \
     -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost"
   ```

4. **Start the relay.**

   ```bash
   node relay/relay.mjs   # https://localhost:8322, bound to 127.0.0.1
   ```

   Open `https://localhost:8322/health` once in your browser and accept the self-signed certificate, so the panel's fetches are not blocked.

5. **Substitute the token into your panel working copy** (the committed source keeps the `__BRIDGE_TOKEN__` placeholder):

   ```bash
   sed "s/__BRIDGE_TOKEN__/$(cat relay/token.txt)/" addon/src/index.js
   ```

   (Apply to the copy the dev server serves, or revert the file afterwards — never commit a real token.)

6. **Run the add-on and load it in Express.**

   ```bash
   cd addon && npm install && npm run start
   ```

   In Adobe Express, use **Add-ons → Test your local add-on**, open the **Express Bridge** panel, and wait for the status to show it is connected to the relay.

7. **Send your first command.**

   ```bash
   TOKEN=$(cat relay/token.txt)
   curl -sk https://localhost:8322/enqueue -H "x-bridge-token: $TOKEN" \
     -H 'Content-Type: application/json' \
     -d '{"id":"t1","type":"ping","params":{}}'
   curl -sk https://localhost:8322/result/t1 -H "x-bridge-token: $TOKEN"
   ```

> Always address the relay as `https://localhost:8322`, never `127.0.0.1` — the certificate SAN covers only `localhost`, and the wrong host fails TLS validation silently.

## Persian / RTL findings (the hard-won part)

These were found by live probing (`probeText*`) and frame-checked rendering, and they apply to **any Arabic-script text** (Persian, Arabic, Urdu) in this Express build:

- **Style through `fullContent.applyCharacterStyles`, styles first.** The working call shape is `applyCharacterStyles(styles, { start, length })` — styles object first, range second; the documented-looking reversed order is rejected by the runtime validator. `color` is a plain RGBA object (`{red, green, blue, alpha}`). `addText` reads back `characterStyleRanges[0]` so you can verify what actually stuck.
- **Never set `node.layout` (AutoHeight) on Arabic-script text.** Setting `layout = {type: 2}` throws `Text native error: non-WebAssembly error` on Persian/RTL nodes in this build (Latin text accepts it), and the error can wedge the sandbox for the next text operation. Instead, the bridge **pre-wraps** text itself: word-boundary line breaks at `maxChars = floor(width / (size × 0.52))`, splitting only on spaces so ZWNJ-joined words stay intact.
- **A text node's `translation` is its centre, not its top-left.** With a `width`, `addText` treats the given `x`/`y` as the block's top-left and shifts by `(width/2, wrappedLines × size × 1.5 / 2)`.
- **`listFonts` is broken in this SDK version** — font enumeration does not return usable results. Resolve fonts by family name (`fonts.fromFamilyAndStyle(name, "Regular")`) and verify visually.

## Security

- The relay binds to `127.0.0.1` only and requires the shared token on every call except `/health`. **Never** expose it on a public interface or port-forward it.
- `relay/token.txt`, `relay/cert.pem`, and `relay/key.pem` are git-ignored; generate your own and rotate the token if it leaks.

## Limitations

- This is a **developer/test add-on** workflow ("Test your local add-on"), not a published add-on; Express must be open with the panel loaded for commands to run.
- The relay queue is in-memory — restarting it drops queued commands.
- `listFonts` is broken in this SDK version (above).
- Panel instances cache their build: after changing sandbox/panel code, relaunch the panel in Express.
- Developed and verified on macOS; the relay is plain Node and should run anywhere, but only the macOS + Express (web) path is battle-tested.

## Documentation

- [Operations notes](docs/OPERATIONS.md) — protocol details, routing rules, deployment gotchas.
- [README به فارسی](README-fa.md)

## License

MIT — © 2026 Saeed Morida. See [LICENSE](LICENSE).
