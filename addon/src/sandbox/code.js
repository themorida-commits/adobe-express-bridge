// Express Bridge — document sandbox side.
// Exposes a small command API to the panel UI via runtime.exposeApi.
// Commands are plain JSON in/out so the relay/UI can pass them through.
import addOnSandboxSdk from "add-on-sdk-document-sandbox";
import { editor, colorUtils, fonts } from "express-document-sdk";

const { runtime } = addOnSandboxSdk.instance;

function hexToColor(hex) {
    const h = (hex || "#16324F").replace("#", "");
    const r = parseInt(h.slice(0, 2), 16) / 255;
    const g = parseInt(h.slice(2, 4), 16) / 255;
    const b = parseInt(h.slice(4, 6), 16) / 255;
    return colorUtils.fromRGB(r, g, b, 1);
}

function allKeys(obj) {
    const keys = new Set();
    let cur = obj;
    while (cur && cur !== Object.prototype) {
        for (const k of Object.getOwnPropertyNames(cur)) keys.add(k);
        cur = Object.getPrototypeOf(cur);
    }
    return [...keys].sort();
}

function safeJson(value) {
    try {
        return JSON.stringify(value, (k, v) => (typeof v === "function" ? "[fn]" : v));
    } catch (e) {
        return "[unserializable: " + e.message + "]";
    }
}

const api = {
    ping() {
        const parent = editor.context.insertionParent;
        return {
            ok: true,
            hasInsertionParent: !!parent,
            parentType: parent ? parent.type : null,
            pageWidth: parent ? parent.width : undefined,
            pageHeight: parent ? parent.height : undefined,
        };
    },

    addRect(params = {}) {
        const { x = 60, y = 60, width = 600, height = 400, fill = "#0E7C7B" } = params;
        const rect = editor.createRectangle();
        rect.width = width;
        rect.height = height;
        rect.translation = { x, y };
        rect.fill = editor.makeColorFill(hexToColor(fill));
        editor.context.insertionParent.children.append(rect);
        return { ok: true, nodeId: rect.id };
    },

    // v1.1: styling goes through fullContent.applyCharacterStyles with the
    // argument order (styles, range) — verified live by probeText2 on
    // 2026-11-02 (the documented-looking order (range, styles) is rejected
    // by the runtime validator). `color` is a plain RGBA object.
    async addText(params = {}) {
        const {
            text = "",
            x = 60,
            y = 60,
            size = 64,
            color = "#16324F",
            fontFamily = null,
            width = null,
        } = params;
        const notes = [];
        const applied = [];
        // Width handling: do NOT use node.layout for Persian/RTL text —
        // probeText5 (2026-11-02) proved setting layout {type:2} on an
        // Arabic-script node throws a native text-engine error in this
        // Express build, while Latin text takes it fine. Instead the bridge
        // pre-wraps the string with explicit line breaks sized to `width`.
        let finalText = text;
        let wrappedLines = 1;
        if (width) {
            const maxChars = Math.max(4, Math.floor(width / (size * 0.52)));
            const words = text.split(" ");
            const lines = [];
            let line = "";
            for (const w of words) {
                if (line && (line + " " + w).length > maxChars) { lines.push(line); line = w; }
                else line = line ? line + " " + w : w;
            }
            if (line) lines.push(line);
            finalText = lines.join("\n");
            wrappedLines = lines.length;
            applied.push("wrap");
        }
        const node = editor.createText(finalText);
        // A text node's translation is its CENTRE (boundsLocal origin sits
        // mid-block — measured in probes and the v15 render). When a width
        // is given, x/y mean the block's top-left, so shift by half the
        // block size: half the wrap width, and half the wrapped height
        // (line height ≈ 1.5 × font size).
        if (width) {
            node.translation = { x: x + width / 2, y: y + (wrappedLines * size * 1.5) / 2 };
            applied.push("anchor");
        } else {
            node.translation = { x, y };
        }
        editor.context.insertionParent.children.append(node);
        const styles = { fontSize: size, color: hexToColor(color) };
        if (fontFamily && fonts && fonts.fromFamilyAndStyle) {
            try {
                const f = await fonts.fromFamilyAndStyle(fontFamily, "Regular");
                if (f) { styles.font = f; applied.push("font"); }
                else notes.push("font not resolved: " + fontFamily);
            } catch (e) { notes.push("font: " + e.message); }
        }
        try {
            node.fullContent.applyCharacterStyles(styles, { start: 0, length: finalText.length });
            applied.push("fontSize", "color");
        } catch (e) { notes.push("applyCharacterStyles: " + e.message); }
        // Read back the first style range so the caller can verify what stuck.
        let readback = null;
        try {
            const r = node.fullContent.characterStyleRanges[0];
            readback = { fontSize: r.fontSize, color: r.color };
        } catch (e) { /* ignore */ }
        return { ok: true, nodeId: node.id, applied, notes, readback, wrappedLines };
    },

    // v1.1 diagnostic: introspect a live TextNode and try each candidate
    // styling path, reporting exactly what exists and what sticks.
    async probeText(params = {}) {
        const report = { ok: true, tries: [] };
        const node = editor.createText("ProbeText123");
        editor.context.insertionParent.children.append(node);
        report.nodeKeys = allKeys(node);
        const full = node.fullContent;
        report.contentKeys = full ? allKeys(full) : null;
        report.hasApplyCharacterStyles = !!(full && typeof full.applyCharacterStyles === "function");
        report.hasTextStyle = "textStyle" in node;
        report.hasFills = "fills" in node;
        const len = "ProbeText123".length;
        const red = editor.makeColorFill(hexToColor("#E2725B"));
        const attempts = [
            ["fullContent.applyCharacterStyles", () => full.applyCharacterStyles({ start: 0, length: len }, { fill: red, fontSize: 44 })],
            ["node.fills=[red]", () => { node.fills = [red]; }],
            ["node.fill=red", () => { node.fill = red; }],
            ["textStyle.fontSize/fill", () => { if (node.textStyle) { node.textStyle.fontSize = 44; } }],
        ];
        for (const [name, fn] of attempts) {
            try { fn(); report.tries.push(name + " -> OK"); }
            catch (e) { report.tries.push(name + " -> ERR " + e.message); }
        }
        try {
            report.rangesAfter = safeJson(full && full.characterStyleRanges);
        } catch (e) { report.rangesAfter = "ERR " + e.message; }
        try {
            const parent = editor.context.insertionParent;
            report.pageWidth = parent.width; report.pageHeight = parent.height;
        } catch (e) { /* ignore */ }
        return report;
    },

    // v1.1 diagnostic round 2: find the exact applyCharacterStyles call shape.
    async probeText2(params = {}) {
        const report = { ok: true, variants: [] };
        const parent = editor.context.insertionParent;
        // Clean up leftovers from probe round 1.
        try {
            for (const child of [...parent.children]) {
                if (child.type === "ab:Text" || (child.text !== undefined && child.fullContent)) {
                    try {
                        if (child.fullContent && child.fullContent.text === "ProbeText123") child.removeFromParent();
                    } catch (e) { /* ignore */ }
                }
            }
        } catch (e) { report.cleanup = "ERR " + e.message; }
        const red = { red: 0.89, green: 0.45, blue: 0.36, alpha: 1 };
        const variants = [
            ["A range{start,end} + styles{fontSize,color}", (n) => n.fullContent.applyCharacterStyles({ start: 0, end: 4 }, { fontSize: 44, color: red })],
            ["B range{start,length} + styles{fontSize,color}", (n) => n.fullContent.applyCharacterStyles({ start: 0, length: 4 }, { fontSize: 44, color: red })],
            ["C single array of style-ranges", (n) => n.fullContent.applyCharacterStyles([{ start: 0, length: 4, fontSize: 44, color: red }])],
            ["D swapped args (styles, range)", (n) => n.fullContent.applyCharacterStyles({ fontSize: 44, color: red }, { start: 0, length: 4 })],
            ["E single object style-range", (n) => n.fullContent.applyCharacterStyles({ start: 0, length: 4, fontSize: 44, color: red })],
        ];
        for (const [name, fn] of variants) {
            const node = editor.createText("ABCD");
            parent.children.append(node);
            let outcome;
            try {
                fn(node);
                const ranges = node.fullContent.characterStyleRanges;
                const first = ranges && ranges[0];
                outcome = "OK ranges=" + safeJson(ranges && ranges.map(r => ({ length: r.length, fontSize: r.fontSize, color: r.color })));
            } catch (e) {
                outcome = "ERR " + e.message;
            }
            report.variants.push(name + " -> " + outcome);
            try { node.removeFromParent(); } catch (e) { /* ignore */ }
        }
        return report;
    },

    // v1.1 diagnostic round 3: how to constrain a TextNode's width so long
    // RTL strings wrap inside the page instead of overflowing the edges.
    async probeText3(params = {}) {
        const report = { ok: true, tries: [] };
        const parent = editor.context.insertionParent;
        const node = editor.createText("AAAA BBBB CCCC DDDD EEEE FFFF GGGG HHHH");
        parent.children.append(node);
        report.layoutJson = safeJson(node.layout);
        report.boundsBefore = safeJson(node.boundsLocal);
        const attempts = [
            ["resize(300,120)", () => node.resize(300, 120)],
            ["layout={width:300}", () => { node.layout = { width: 300 }; }],
            ["width=300 direct", () => { node.width = 300; }],
        ];
        for (const [name, fn] of attempts) {
            try { fn(); report.tries.push(name + " -> OK bounds=" + safeJson(node.boundsLocal)); }
            catch (e) { report.tries.push(name + " -> ERR " + e.message); }
        }
        try { node.removeFromParent(); } catch (e) { /* ignore */ }
        return report;
    },

    // v1.1 diagnostic round 4: pin down the width-constraining call.
    async probeText4(params = {}) {
        const report = { ok: true, tries: [] };
        const parent = editor.context.insertionParent;
        const sample = "AAAA BBBB CCCC DDDD EEEE FFFF GGGG HHHH";
        const attempts = [
            ["resize({width:300})", (n) => n.resize({ width: 300 })],
            ["resize({width:300,height:400})", (n) => n.resize({ width: 300, height: 400 })],
            ["layout AutoHeightTextLayout str", (n) => { n.layout = { type: "AutoHeightTextLayout", width: 300 }; }],
            ["layout auto-height str", (n) => { n.layout = { type: "auto-height", width: 300 }; }],
            ["layout type:1 + width", (n) => { n.layout = { type: 1, width: 300 }; }],
            ["layout type:2 + width", (n) => { n.layout = { type: 2, width: 300 }; }],
            ["layout type:4 + width", (n) => { n.layout = { type: 4, width: 300 }; }],
        ];
        for (const [name, fn] of attempts) {
            const node = editor.createText(sample);
            parent.children.append(node);
            try {
                fn(node);
                const b = node.boundsLocal;
                report.tries.push(name + " -> OK bounds w=" + Math.round(b.width) + " h=" + Math.round(b.height) + " layout=" + safeJson(node.layout));
            } catch (e) {
                report.tries.push(name + " -> ERR " + e.message);
            }
            try { node.removeFromParent(); } catch (e) { /* ignore */ }
        }
        return report;
    },

    // v1.1 diagnostic round 5: isolate why layout fails in addText but
    // worked in probeText4 — RTL content? translation? order?
    async probeText5(params = {}) {
        const report = { ok: true, tries: [] };
        const parent = editor.context.insertionParent;
        const FA = "وقتی جواب نمی‌ده، چی کار می‌کنی؟";
        const EN = "AAAA BBBB CCCC DDDD EEEE FFFF GGGG HHHH";
        const variants = [
            ["A fa, append, layout", (n) => { parent.children.append(n); n.layout = { type: 2, width: 300 }; }, FA],
            ["B en, translation, append, layout", (n) => { n.translation = { x: 20, y: 40 }; parent.children.append(n); n.layout = { type: 2, width: 300 }; }, EN],
            ["C fa, append, layout, then translation", (n) => { parent.children.append(n); n.layout = { type: 2, width: 300 }; n.translation = { x: 20, y: 40 }; }, FA],
        ];
        for (const [name, fn, txt] of variants) {
            const node = editor.createText(txt);
            try {
                fn(node);
                const b = node.boundsLocal;
                report.tries.push(name + " -> OK bounds w=" + Math.round(b.width) + " h=" + Math.round(b.height));
            } catch (e) {
                report.tries.push(name + " -> ERR " + e.message);
                try { parent.children.append(node); } catch (e2) { /* ignore */ }
            }
            try { node.removeFromParent(); } catch (e) { /* ignore */ }
        }
        return report;
    },

    async listFonts(params = {}) {
        const query = (params.query || "").toLowerCase();
        try {
            const available = await fonts.getAvailableFonts();
            const names = [];
            for (const f of available) {
                const name = f.family || f.name || f.postScriptName || "";
                if (!query || String(name).toLowerCase().includes(query)) names.push(String(name));
                if (names.length >= 60) break;
            }
            return { ok: true, fonts: names };
        } catch (e) {
            return { ok: false, error: String(e && e.message || e) };
        }
    },
};

function start() {
    runtime.exposeApi(api);
    console.log("Express Bridge sandbox ready.");
}

start();
