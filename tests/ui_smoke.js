/**
 * UI smoke-test entry. Starts the local web fixture, then spawns the real
 * Electron app with --smoke=<dir>, which loads the backend, takes screenshots
 * and exercises text/video/game/web/OCR/floating pipelines.
 */
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");

const root = path.join(__dirname, "..");
const electron = path.join(root, "node_modules", "electron", "dist", "electron.exe");
const out = process.argv[2] || path.join(root, "tests", "shots");
if (!fs.existsSync(electron)) {
  console.error("Electron is not installed. Run: npm install");
  process.exit(1);
}
fs.mkdirSync(out, { recursive: true });

const fixturePath = path.join(root, "tests", "web_fixture.html");
const fixture = http.createServer((req, res) => {
  if (req.url && req.url.startsWith("/web_fixture.html") && fs.existsSync(fixturePath)) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(fs.readFileSync(fixturePath));
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("fixture not found");
});
let started = false;
let child = null;

function startApp() {
  if (started) return;
  started = true;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(electron, [root, `--smoke=${out}`], {
    cwd: root,
    env,
    stdio: "inherit",
    windowsHide: false,
  });
  child.on("exit", (code) => {
    const summary = path.join(out, "smoke.json");
    if (fs.existsSync(summary)) console.log("Smoke summary:", summary);
    try { fixture.close(); } catch {}
    process.exit(code || 0);
  });
}

fixture.on("error", (error) => {
  console.warn("Fixture server unavailable, continuing:", error.message);
  startApp();
});
fixture.listen(52020, "127.0.0.1", startApp);
