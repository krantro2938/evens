const MAX_LOG_LINES = 80;

let logPanel: HTMLPreElement | null = null;

function getLogPanel() {
    if (logPanel) return logPanel;

    logPanel = document.createElement("pre");
    logPanel.id = "debug-log";
    logPanel.style.cssText = [
        "position:fixed",
        "left:12px",
        "right:12px",
        "bottom:48px",
        "max-height:35vh",
        "overflow:auto",
        "margin:0",
        "padding:10px",
        "box-sizing:border-box",
        "background:#111",
        "border:1px solid #555",
        "border-radius:8px",
        "color:#9f9",
        "font:12px/1.4 monospace",
        "text-align:left",
        "white-space:pre-wrap",
        "z-index:9999",
    ].join(";");
    document.body.appendChild(logPanel);
    return logPanel;
}

function format(value: unknown) {
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    if (typeof value === "string") return value;
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

export function appLog(...values: unknown[]) {
    const line = `[${new Date().toLocaleTimeString()}] ${values.map(format).join(" ")}`;
    console.log(...values);

    const panel = getLogPanel();
    const lines = panel.textContent ? panel.textContent.split("\n") : [];
    lines.push(line);
    panel.textContent = lines.slice(-MAX_LOG_LINES).join("\n");
    panel.scrollTop = panel.scrollHeight;
}
