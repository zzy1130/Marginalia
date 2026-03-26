/**
 * Marginalia — Electrobun main process.
 * Creates the main window and tray shell.
 */

import { BrowserWindow, ApplicationMenu, Tray } from "electrobun/bun";
import { startServer } from "./server";

// --- Start the agent server ---
startServer();

// --- UI ---
ApplicationMenu.setApplicationMenu([
  {
    submenu: [{ label: "Quit Marginalia", role: "quit" }],
  },
  {
    label: "Edit",
    submenu: [
      { role: "undo" }, { role: "redo" }, { type: "separator" },
      { role: "cut" }, { role: "copy" }, { role: "paste" },
      { role: "pasteAndMatchStyle" }, { role: "delete" }, { role: "selectAll" },
    ],
  },
]);

// --- Main window ---
const mainWin = new BrowserWindow({
  title: "Marginalia",
  url: "views://mainview/index.html",
  titleBarStyle: "hiddenInset",
  frame: { width: 440, height: 660, x: 100, y: 100 },
});

// --- Tray ---
const tray = new Tray({ title: "Marginalia" });

tray.on("tray-clicked", (e) => {
  const { action } = e.data as { id: number; action: string };
  if (action === "") {
    tray.setMenu([
      { type: "normal", label: "Show / Hide", action: "toggle" },
      { type: "divider" },
      { type: "normal", label: "Quit Marginalia", action: "quit" },
    ]);
  } else if (action === "toggle") {
    mainWin.focus();
  } else if (action === "quit") {
    process.exit(0);
  }
});

console.log("[main] Marginalia started.");
