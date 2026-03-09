/**
 * Marginalia webview — chat UI, robot animation.
 * Communicates with the Python backend via fetch + SSE.
 */

import { marked } from "marked";

marked.setOptions({ breaks: true, gfm: true });

const API_BASE = "http://127.0.0.1:8765";

let isBusy = false;
let chatMessages: HTMLElement;

function robotState(state: string) {
  const body = document.getElementById("robotBody");
  if (!body) return;
  body.classList.remove("idle", "listening", "thinking", "explaining", "happy", "error");
  if (state !== "idle") body.classList.add(state);
}

function setStatus(text: string, type: string) {
  const badge = document.getElementById("statusBadge");
  if (!badge) return;
  badge.textContent = text;
  badge.className = "status-badge" + (type ? ` ${type}` : "");
}

function scrollToBottom() {
  if (!chatMessages) return;
  requestAnimationFrame(() => { chatMessages.scrollTop = chatMessages.scrollHeight; });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function appendUserMsg(text: string) {
  if (!chatMessages) return;
  const div = document.createElement("div");
  div.className = "msg-user";
  div.innerHTML = `<div class="msg-user-label">YOU</div><div class="msg-user-text">${escapeHtml(text)}</div>`;
  chatMessages.appendChild(div);
  scrollToBottom();
}

function appendBotHeader() {
  if (!chatMessages) return;
  const div = document.createElement("div");
  div.className = "msg-bot-label";
  div.textContent = "MARGINALIA";
  chatMessages.appendChild(div);
  scrollToBottom();
}

function appendStatus(status: string) {
  if (!chatMessages) return;
  const div = document.createElement("div");
  div.className = "msg-status";
  div.textContent = status;
  chatMessages.appendChild(div);
  scrollToBottom();
}

function renderMath(el: HTMLElement) {
  if (typeof (window as any).renderMathInElement === "function") {
    (window as any).renderMathInElement(el, {
      delimiters: [
        { left: "$$", right: "$$", display: true },
        { left: "$", right: "$", display: false },
      ],
      throwOnError: false,
    });
  }
}

function sanitizeHtml(html: string): string {
  const purify = (window as any).DOMPurify;
  if (purify) {
    return purify.sanitize(html, {
      ALLOWED_TAGS: [
        "h1", "h2", "h3", "h4", "h5", "h6", "p", "br", "hr",
        "ul", "ol", "li", "blockquote", "pre", "code",
        "strong", "b", "em", "i", "u", "s", "del",
        "table", "thead", "tbody", "tr", "th", "td",
        "a", "img", "span", "div", "sup", "sub",
      ],
      ALLOWED_ATTR: [
        "href", "src", "alt", "title", "class", "width", "height",
        "style", "target", "rel",
      ],
      ALLOW_DATA_ATTR: false,
    });
  }
  return html;
}

function appendBotText(text: string) {
  if (!chatMessages) return;
  const div = document.createElement("div");
  div.className = "msg-bot-text";
  const rawHtml = marked.parse(text) as string;
  div.innerHTML = sanitizeHtml(rawHtml);
  chatMessages.appendChild(div);
  renderMath(div);
  scrollToBottom();
}

function appendError(error: string) {
  if (!chatMessages) return;
  const div = document.createElement("div");
  div.className = "msg-error";
  div.textContent = error;
  chatMessages.appendChild(div);
  scrollToBottom();
}

function setButtonsEnabled(enabled: boolean) {
  const btn = document.getElementById("sendBtn") as HTMLButtonElement | null;
  if (btn) btn.disabled = !enabled;
  const input = document.getElementById("inputField") as HTMLInputElement | null;
  if (input) input.disabled = !enabled;
}

function handleEvent(type: string, data: string) {
  switch (type) {
    case "status":
      setStatus(data, "thinking");
      appendStatus(data);
      robotState("thinking");
      break;
    case "text":
      appendBotText(data);
      robotState("explaining");
      break;
    case "done":
      setStatus("Ready", "");
      setButtonsEnabled(true);
      isBusy = false;
      robotState("happy");
      setTimeout(() => robotState("idle"), 2500);
      break;
    case "error":
      setStatus("Error", "error");
      appendError(data);
      setButtonsEnabled(true);
      isBusy = false;
      robotState("error");
      setTimeout(() => robotState("idle"), 3000);
      break;
  }
}

async function sendMessage(text: string) {
  if (isBusy || !text.trim()) return;
  isBusy = true;
  setButtonsEnabled(false);

  robotState("listening");
  appendUserMsg(text);
  appendBotHeader();
  robotState("thinking");
  setStatus("Thinking…", "thinking");

  try {
    const res = await fetch(`${API_BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });

    if (!res.ok) {
      handleEvent("error", `Backend error: ${res.status}`);
      return;
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() || "";

      for (const part of parts) {
        if (part.startsWith("data: ")) {
          try {
            const event = JSON.parse(part.slice(6));
            handleEvent(event.type, event.data);
          } catch { /* skip malformed */ }
        }
      }
    }

    if (!isBusy) return;
    handleEvent("done", "");
  } catch (err) {
    handleEvent("error", `Connection failed: ${err}`);
  }
}

// --- Eye tracking: pupils follow the mouse ---
function setupEyeTracking() {
  const svg = document.querySelector(".robot-svg") as SVGSVGElement | null;
  if (!svg) return;

  const pupilL = document.getElementById("pupilL");
  const pupilR = document.getElementById("pupilR");
  if (!pupilL || !pupilR) return;

  const eyeLCenter = { x: 52, y: 64 };
  const eyeRCenter = { x: 88, y: 64 };
  const maxOffset = 4;

  document.addEventListener("mousemove", (e) => {
    const rect = svg.getBoundingClientRect();
    const svgCenterX = rect.left + rect.width / 2;
    const svgCenterY = rect.top + rect.height * 0.36;

    const dx = e.clientX - svgCenterX;
    const dy = e.clientY - svgCenterY;
    const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
    const ox = (dx / dist) * maxOffset;
    const oy = (dy / dist) * Math.min(maxOffset, maxOffset * 0.7);

    pupilL.setAttribute("cx", String(eyeLCenter.x + ox));
    pupilL.setAttribute("cy", String(eyeLCenter.y + oy));
    pupilR.setAttribute("cx", String(eyeRCenter.x + ox));
    pupilR.setAttribute("cy", String(eyeRCenter.y + oy));
  });
}

// --- Click cat to wave ---
function setupRobotClick() {
  const svg = document.querySelector(".robot-svg");
  if (!svg) return;

  svg.addEventListener("click", () => {
    if (isBusy) return;
    robotState("happy");
    setTimeout(() => robotState("idle"), 1500);
  });
}

// --- Blinking ---
function setupBlink() {
  function doBlink() {
    const body = document.getElementById("robotBody");
    if (!body || body.classList.contains("happy") || body.classList.contains("error")) return;
    body.classList.add("blink");
    setTimeout(() => body.classList.remove("blink"), 130);
  }

  let timer = setInterval(doBlink, 3000);
  setInterval(() => {
    clearInterval(timer);
    timer = setInterval(doBlink, 2000 + Math.random() * 3000);
  }, 7000);

  setInterval(() => {
    doBlink();
    setTimeout(doBlink, 300);
  }, 12000);
}

async function checkSandboxStatus() {
  try {
    const res = await fetch(`${API_BASE}/health`);
    if (res.ok) {
      const data = await res.json();
      if (data.sandbox === "fallback") {
        appendStatus(
          "Sandbox unavailable. Code runs in restricted mode. " +
          "Install Docker Desktop for full isolation."
        );
      }
    }
  } catch { /* backend not ready yet */ }
}

// --- Initialize ---
document.addEventListener("DOMContentLoaded", () => {
  chatMessages = document.getElementById("chatMessages")!;

  setupEyeTracking();
  setupBlink();
  setupRobotClick();
  checkSandboxStatus();

  const inputField = document.getElementById("inputField") as HTMLInputElement;

  document.getElementById("sendBtn")!.addEventListener("click", () => {
    const text = inputField.value.trim();
    if (text) { inputField.value = ""; sendMessage(text); }
  });

  inputField.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const text = inputField.value.trim();
      if (text) { inputField.value = ""; sendMessage(text); }
    }
  });
});
