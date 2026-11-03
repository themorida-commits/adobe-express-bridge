// Express Bridge — panel UI side.
// Polls the local relay for commands from an AI agent, executes them against the
// document (via the sandbox proxy or the UI SDK), and posts results back.
import addOnUISdk from "https://new.express.adobe.com/static/add-on-sdk/sdk.js";

const RELAY = "https://localhost:8322";
const TOKEN = "__BRIDGE_TOKEN__"; // replaced at deploy time from relay/token.txt — see README "Setup"
const SANDBOX_CMDS = new Set(["ping", "addRect", "addText", "listFonts", "probeText", "probeText2", "probeText3", "probeText4", "probeText5"]);

const statusEl = document.getElementById("status");
const logEl = document.getElementById("log");
function log(msg) {
    const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
    console.log(line);
    if (logEl) logEl.textContent = line + "\n" + logEl.textContent.slice(0, 1200);
}
function setStatus(s) { if (statusEl) statusEl.textContent = s; }

async function relay(path, body) {
    const res = await fetch(RELAY + path, {
        method: body ? "POST" : "GET",
        headers: { "Content-Type": "application/json", "x-bridge-token": TOKEN },
        body: body ? JSON.stringify(body) : undefined,
    });
    return res.json();
}

function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

addOnUISdk.ready.then(async () => {
    const { runtime } = addOnUISdk.instance;
    const sandboxProxy = await runtime.apiProxy("documentSandbox");
    setStatus("Panel ready. Connecting to relay…");
    log("sandbox proxy ready");

    async function execOnSandbox(cmd) {
        const fn = sandboxProxy[cmd.type];
        if (typeof fn !== "function") throw new Error("unknown sandbox command: " + cmd.type);
        return fn(cmd.params || {});
    }

    async function execExport(cmd) {
        // UI-SDK rendition of the current page to PNG.
        const app = addOnUISdk.app;
        if (!app || !app.document || !app.document.createRenditions) {
            throw new Error("createRenditions not available on app.document");
        }
        const C = addOnUISdk.constants || {};
        const renditionOptions = {
            range: (C.Range && (C.Range.currentPage || C.Range.entireDocument)) || "currentPage",
            format: (C.RenditionFormat && C.RenditionFormat.png) || "image/png",
        };
        const intent = (C.RenditionIntent && (C.RenditionIntent.export || C.RenditionIntent.preview)) || "export";
        const renditions = await app.document.createRenditions(renditionOptions, intent);
        if (!renditions || !renditions.length) throw new Error("no rendition returned");
        const blob = renditions[0].blob || renditions[0];
        const pngBase64 = await blobToBase64(blob);
        return { ok: true, pngBase64 };
    }

    async function handle(cmd) {
        log("cmd " + cmd.type + " (" + cmd.id + ")");
        try {
            let data;
            if (SANDBOX_CMDS.has(cmd.type)) data = await execOnSandbox(cmd);
            else if (cmd.type === "exportPage") data = await execExport(cmd);
            else throw new Error("unknown command type: " + cmd.type);
            const payload = { id: cmd.id, ok: true, data: {} };
            if (data && data.pngBase64) { payload.pngBase64 = data.pngBase64; delete data.pngBase64; }
            payload.data = data;
            await relay("/result", payload);
            log("done " + cmd.id);
        } catch (e) {
            log("error " + cmd.id + ": " + (e && e.message || e));
            try { await relay("/result", { id: cmd.id, ok: false, error: String(e && e.message || e) }); } catch {}
        }
    }

    let failures = 0;
    async function loop() {
        try {
            const { cmd } = await relay("/poll");
            failures = 0;
            setStatus("Connected to relay. Idle.");
            if (cmd) { setStatus("Running: " + cmd.type); await handle(cmd); }
        } catch (e) {
            failures++;
            setStatus("Relay not reachable (" + failures + "). Accept the relay certificate, then wait.");
            if (failures === 1) log("poll failed: " + (e && e.message || e));
        }
        setTimeout(loop, 1500);
    }
    loop();

    const testBtn = document.getElementById("testText");
    if (testBtn) testBtn.addEventListener("click", async () => {
        await handle({ id: "manual-" + Date.now(), type: "addText", params: { text: "Bridge OK", x: 80, y: 80, size: 72 } });
    });
});
