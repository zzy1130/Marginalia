const http = require("http");
const vscode = require("vscode");

const PORT = 18765;
let server;

function activate() {
  server = http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }

    if (req.method === "GET" && req.url === "/terminals") {
      Promise.all(
        vscode.window.terminals.map(async (t, i) => ({
          index: i,
          name: t.name,
          pid: await t.processId,
        }))
      ).then((list) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(list));
      });
      return;
    }

    if (req.method === "POST" && req.url === "/send") {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", async () => {
        try {
          const { text, terminalName, terminalIndex, pid } = JSON.parse(body);
          const terminals = vscode.window.terminals;
          let target;

          if (pid) {
            const results = await Promise.all(
              terminals.map(async (t) => ({ t, pid: await t.processId }))
            );
            target = results.find((r) => String(r.pid) === String(pid))?.t;
          } else if (typeof terminalIndex === "number" && terminals[terminalIndex]) {
            target = terminals[terminalIndex];
          } else if (terminalName) {
            target = terminals.find((t) => t.name.includes(terminalName));
          } else {
            target = vscode.window.activeTerminal;
          }

          if (target) {
            target.sendText(text, true);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, terminal: target.name }));
          } else {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "terminal not found" }));
          }
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: String(e) }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end("not found");
  });

  server.listen(PORT, "127.0.0.1", () => {
    console.log(`[marginalia-bridge] Listening on http://127.0.0.1:${PORT}`);
  });
}

function deactivate() {
  if (server) server.close();
}

module.exports = { activate, deactivate };
