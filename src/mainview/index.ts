/**
 * Marginalia webview — chat UI, robot animation, terminal alert handling.
 * Communicates with the Bun backend via fetch + SSE.
 */

import ElectrobunView, { Electroview } from "electrobun/view";
import { marked } from "marked";

const rpc = Electroview.defineRPC<any>({
  handlers: { requests: {}, messages: {} },
});
new ElectrobunView.Electroview({ rpc });

marked.setOptions({ breaks: true, gfm: true });

const API_BASE = "http://127.0.0.1:8765";

let isBusy = false;
let chatMessages: HTMLElement;
let responseTargetTab: string | null = null;
let nextMoveTrigger: HTMLButtonElement | null = null;
let nextMoveTriggerLabelEl: HTMLElement | null = null;
let threadkeeperDock: HTMLElement | null = null;
let threadkeeperShell: HTMLElement | null = null;
let threadkeeperSummaryEl: HTMLElement | null = null;
let threadkeeperMetaEl: HTMLElement | null = null;
let threadkeeperTimeEl: HTMLElement | null = null;
let threadkeeperFocusEl: HTMLElement | null = null;
let threadkeeperTasksEl: HTMLElement | null = null;
let threadkeeperAvoidEl: HTMLElement | null = null;
let threadkeeperActionsEl: HTMLElement | null = null;
let threadkeeperPanelTitleEl: HTMLElement | null = null;
let threadkeeperOpen = false;
let threadkeeperSticky = false;
let threadkeeperAutoCloseTimer: number | null = null;

// ── Agent switching state ────────────────────────────────────────

let currentAgentId: string | null = null;
let agentList: { id: string; name: string; description: string }[] = [];

const AGENT_LABELS: Record<string, string> = {
  pdf_study: "PDF",
  terminal_helper: "TERM",
};

const AGENT_PLACEHOLDERS: Record<string, string> = {
  pdf_study: "Ask about the current page...",
  terminal_helper: "Respond to a terminal...",
};

interface ThreadkeeperCard {
  id: string;
  title: string;
  summary: string;
  focus: string;
  details: string[];
  accent: "terminal" | "document" | "context";
  urgency?: "low" | "medium" | "high";
  nextMove?: string;
  whyNow?: string;
  tasks?: string[];
  avoid?: string[];
  actions?: ThreadkeeperAction[];
  timestamp: number;
}

let latestThreadkeeperCard: ThreadkeeperCard | null = null;

interface ThreadkeeperAction {
  id: string;
  label: string;
  kind: "switch_agent" | "prompt";
  agentId?: "pdf_study" | "terminal_helper";
  prompt?: string;
}

function switchAgent(agentId: string) {
  currentAgentId = agentId;
  const badge = document.getElementById("agentBadge");
  if (badge) badge.textContent = AGENT_LABELS[agentId] ?? agentId;

  const input = document.getElementById("inputField") as HTMLInputElement | null;
  if (input) {
    input.placeholder = AGENT_PLACEHOLDERS[agentId] ?? "Type a message...";
  }

  if (agentId === "terminal_helper") {
    startTerminalMonitor();
    if (activeTabId) {
      switchTab(activeTabId);
    } else if (terminalTabs.size > 0) {
      switchTab(terminalTabs.keys().next().value!);
    }
    renderTabs();
  } else {
    stopTerminalMonitor();
    showDefaultTab();
  }

  renderAgentMenu();
  closeAgentMenu();
}

function renderAgentMenu() {
  const menu = document.getElementById("agentMenu");
  if (!menu) return;

  menu.innerHTML = agentList.map((a) => `
    <div class="agent-menu-item ${a.id === currentAgentId ? "active" : ""}" data-agent-id="${a.id}">
      <span class="agent-menu-item-dot"></span>
      ${escapeHtml(AGENT_LABELS[a.id] ?? a.id)} &mdash; ${escapeHtml(a.description)}
    </div>
  `).join("");

  menu.querySelectorAll(".agent-menu-item").forEach((el) => {
    el.addEventListener("click", () => {
      const id = (el as HTMLElement).dataset.agentId;
      if (id) switchAgent(id);
    });
  });
}

function toggleAgentMenu() {
  const menu = document.getElementById("agentMenu");
  if (menu) menu.classList.toggle("open");
}

function closeAgentMenu() {
  const menu = document.getElementById("agentMenu");
  if (menu) menu.classList.remove("open");
}

async function fetchAgentList() {
  try {
    const res = await fetch(`${API_BASE}/api/agents`);
    if (res.ok) {
      agentList = await res.json();
      if (!currentAgentId && agentList.length > 0) {
        currentAgentId = agentList[0].id;
        switchAgent(currentAgentId);
      }
      renderAgentMenu();
    }
  } catch { /* backend not ready */ }
}

// ── Terminal tabs ────────────────────────────────────────────────

interface TabInfo {
  id: string;
  label: string;
  command: string;
  source: string;
  hasUnread: boolean;
  lastEvent: any;
  lastEventSeq: number;
}

const terminalTabs = new Map<string, TabInfo>();
let activeTabId: string | null = null;

function extractLabel(command: string): string {
  const parts = command.split(/\s+/);
  for (const p of parts.reverse()) {
    const clean = p.replace(/['"]/g, "");
    if (clean && !clean.includes("=") && !clean.includes("/") && clean.length < 20) return clean;
  }
  return command.slice(0, 15);
}

function ensureTab(termId: string, source: string, name: string, command: string): TabInfo {
  let tab = terminalTabs.get(termId);
  if (!tab) {
    tab = { id: termId, label: extractLabel(command), command, source, hasUnread: false, lastEvent: null, lastEventSeq: 0 };
    terminalTabs.set(termId, tab);

    const container = document.createElement("div");
    container.className = "tab-content";
    container.dataset.tab = termId;
    chatMessages.appendChild(container);
  }
  return tab;
}

function renderTabs() {
  const bar = document.getElementById("terminalTabs");
  if (!bar) return;

  if (currentAgentId !== "terminal_helper" || terminalTabs.size === 0) {
    bar.classList.remove("visible");
    return;
  }

  bar.classList.add("visible");
  bar.innerHTML = "";

  for (const [id, tab] of terminalTabs) {
    const el = document.createElement("div");
    el.className = `terminal-tab${id === activeTabId ? " active" : ""}`;
    el.innerHTML = `<span class="terminal-tab-dot${tab.hasUnread ? " unread" : ""}"></span>${escapeHtml(tab.label)}`;
    el.addEventListener("click", () => switchTab(id));
    bar.appendChild(el);
  }
}

function switchTab(tabId: string) {
  activeTabId = tabId;

  const tab = terminalTabs.get(tabId);
  if (tab) {
    tab.hasUnread = false;
  }

  chatMessages.querySelectorAll(".tab-content").forEach((el) => {
    (el as HTMLElement).classList.toggle("active", (el as HTMLElement).dataset.tab === tabId);
  });

  renderTabs();
  scrollToBottom();
}

function showDefaultTab() {
  activeTabId = null;
  chatMessages.querySelectorAll(".tab-content").forEach((el) => {
    (el as HTMLElement).classList.toggle("active", (el as HTMLElement).dataset.tab === "default");
  });
  renderTabs();
}

function appendToTab(termId: string, element: HTMLElement) {
  let container = chatMessages.querySelector(`.tab-content[data-tab="${termId}"]`) as HTMLElement | null;
  if (!container) {
    container = document.createElement("div");
    container.className = "tab-content";
    container.dataset.tab = termId;
    chatMessages.appendChild(container);
  }
  element.dataset.eventSeq = element.dataset.eventSeq ?? "";
  container.appendChild(element);

  if (termId === activeTabId) {
    scrollToBottom();
  } else {
    const tab = terminalTabs.get(termId);
    if (tab) {
      tab.hasUnread = true;
      renderTabs();
    }
  }
}

function getActiveTerminalContext(): any | null {
  if (!activeTabId) return null;
  const tab = terminalTabs.get(activeTabId);
  if (!tab) return null;
  return tab.lastEvent ?? { id: tab.id, source: tab.source, command: tab.command, name: tab.label };
}

// ── Robot state ──────────────────────────────────────────────────

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

function setAgentBadge(agentId: string) {
  if (agentId !== currentAgentId) switchAgent(agentId);
}

function scrollToBottom() {
  if (!chatMessages) return;
  requestAnimationFrame(() => { chatMessages.scrollTop = chatMessages.scrollHeight; });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatThreadkeeperTime(timestamp: number): string {
  const delta = Date.now() - timestamp;
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.max(1, Math.floor(delta / 60_000))}m ago`;

  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function syncThreadkeeperVisibility() {
  nextMoveTrigger?.classList.add("visible");
  threadkeeperDock?.classList.toggle("visible", threadkeeperOpen && Boolean(latestThreadkeeperCard));
}

function clearThreadkeeperAutoCloseTimer() {
  if (threadkeeperAutoCloseTimer !== null) {
    window.clearTimeout(threadkeeperAutoCloseTimer);
    threadkeeperAutoCloseTimer = null;
  }
}

function scheduleThreadkeeperAutoClose(delay = 6500) {
  clearThreadkeeperAutoCloseTimer();
  if (threadkeeperSticky || !threadkeeperOpen) return;
  threadkeeperAutoCloseTimer = window.setTimeout(() => {
    setThreadkeeperOpen(false);
  }, delay);
}

function setThreadkeeperOpen(open: boolean, sticky = false) {
  threadkeeperOpen = open;
  threadkeeperSticky = open ? sticky : false;
  if (!open) {
    clearThreadkeeperAutoCloseTimer();
  }
  syncThreadkeeperVisibility();
}

function pulseThreadkeeperShell() {
  if (!threadkeeperShell) return;
  threadkeeperShell.classList.remove("fresh");
  nextMoveTrigger?.classList.remove("hot");
  requestAnimationFrame(() => {
    threadkeeperShell?.classList.add("fresh");
    nextMoveTrigger?.classList.add("hot");
    window.setTimeout(() => {
      threadkeeperShell?.classList.remove("fresh");
      if (!threadkeeperOpen) {
        nextMoveTrigger?.classList.remove("hot");
      }
    }, 1800);
  });
}

function setNextMoveTriggerLabel(text: string) {
  if (!nextMoveTriggerLabelEl) return;
  nextMoveTriggerLabelEl.textContent = "Next";
}

function setThreadkeeperSectionVisible(target: HTMLElement | null, visible: boolean) {
  const section = target?.closest(".threadkeeper-section") as HTMLElement | null;
  if (section) {
    section.style.display = visible ? "" : "none";
  }
}

async function refreshThreadkeeperCard(options: { open?: boolean; sticky?: boolean } = {}) {
  try {
    const res = await fetch(`${API_BASE}/api/threadkeeper-card`);
    if (!res.ok) return;
    const payload = await res.json();
    if (!payload?.card) return;
    renderThreadkeeperCard(payload.card as ThreadkeeperCard);
    if (options.open) {
      setThreadkeeperOpen(true, options.sticky ?? true);
    }
  } catch {
    // backend may still be booting
  }
}

function renderThreadkeeperActions(actions: ThreadkeeperAction[]) {
  if (!threadkeeperActionsEl) return;

  threadkeeperActionsEl.innerHTML = "";
  for (const [index, action] of actions.entries()) {
    const btn = document.createElement("button");
    btn.className = `threadkeeper-action-btn ${index === 0 ? "primary" : "secondary"}`;
    btn.textContent = action.label;
    btn.addEventListener("click", () => {
      runThreadkeeperAction(action);
    });
    threadkeeperActionsEl.appendChild(btn);
  }
}

function renderThreadkeeperPills(target: HTMLElement | null, items: string[], variant: "default" | "avoid" = "default") {
  if (!target) return;
  target.innerHTML = items
    .map((item) => `<div class="threadkeeper-detail-pill${variant === "avoid" ? " avoid" : ""}">${escapeHtml(item)}</div>`)
    .join("");
}

function renderThreadkeeperCard(card: ThreadkeeperCard) {
  const hadCard = Boolean(latestThreadkeeperCard);
  latestThreadkeeperCard = card;
  syncThreadkeeperVisibility();

  if (!threadkeeperShell || !threadkeeperSummaryEl || !threadkeeperMetaEl || !threadkeeperTimeEl || !threadkeeperFocusEl || !threadkeeperTasksEl || !threadkeeperAvoidEl || !threadkeeperPanelTitleEl) {
    return;
  }

  const nextMove = card.nextMove ?? card.summary;
  const whyNow = card.whyNow ?? card.focus;
  const tasks = Array.isArray(card.tasks) && card.tasks.length > 0 ? card.tasks : card.details.slice(0, 3);
  const avoid = Array.isArray(card.avoid) ? card.avoid : [];
  const actions = Array.isArray(card.actions) ? card.actions : [];
  const urgency = card.urgency ?? (card.accent === "terminal" ? "high" : "medium");
  const showFocus = Boolean(card.focus) && !/marginalia|\.pdf|\.ppt|\.pptx|\.key/i.test(card.focus);

  threadkeeperShell.dataset.urgency = urgency;
  nextMoveTrigger?.setAttribute("data-urgency", urgency);
  nextMoveTrigger?.setAttribute("title", nextMove);
  setNextMoveTriggerLabel(nextMove);
  threadkeeperSummaryEl.textContent = nextMove;
  threadkeeperMetaEl.textContent = whyNow;
  threadkeeperTimeEl.textContent = formatThreadkeeperTime(card.timestamp);
  threadkeeperPanelTitleEl.textContent = card.title || "What Now";
  threadkeeperFocusEl.textContent = `当前上下文: ${card.focus}`;
  threadkeeperFocusEl.style.display = showFocus ? "" : "none";

  renderThreadkeeperPills(threadkeeperTasksEl, tasks);
  renderThreadkeeperPills(threadkeeperAvoidEl, avoid, "avoid");
  renderThreadkeeperActions(actions);
  setThreadkeeperSectionVisible(threadkeeperTasksEl, tasks.length > 0);
  setThreadkeeperSectionVisible(threadkeeperAvoidEl, avoid.length > 0);

  pulseThreadkeeperShell();

  if (urgency === "high") {
    setThreadkeeperOpen(true, false);
    scheduleThreadkeeperAutoClose();
  } else {
    syncThreadkeeperVisibility();
  }
}

function runThreadkeeperAction(action: ThreadkeeperAction) {
  if (action.agentId) {
    switchAgent(action.agentId);
  }

  const input = document.getElementById("inputField") as HTMLInputElement | null;
  if (input && action.prompt) {
    input.value = action.prompt;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  } else {
    input?.focus();
  }

  nextMoveTrigger?.classList.remove("hot");
  setThreadkeeperOpen(false);
}

// ── Chat message rendering ───────────────────────────────────────

function getActiveContainer(): HTMLElement {
  const tabId = responseTargetTab ?? activeTabId;
  if (currentAgentId === "terminal_helper" && tabId) {
    const c = chatMessages.querySelector(`.tab-content[data-tab="${tabId}"]`) as HTMLElement | null;
    if (c) return c;
  }
  return chatMessages.querySelector('.tab-content[data-tab="default"]') as HTMLElement ?? chatMessages;
}

function appendUserMsg(text: string) {
  const c = getActiveContainer();
  const div = document.createElement("div");
  div.className = "msg-user";
  div.innerHTML = `<div class="msg-user-label">YOU</div><div class="msg-user-text">${escapeHtml(text)}</div>`;
  c.appendChild(div);
  scrollToBottom();
}

function appendBotHeader() {
  const c = getActiveContainer();
  const div = document.createElement("div");
  div.className = "msg-bot-label";
  div.textContent = "MARGINALIA";
  c.appendChild(div);
  scrollToBottom();
}

function appendStatus(status: string) {
  const c = getActiveContainer();
  const div = document.createElement("div");
  div.className = "msg-status";
  div.textContent = status;
  c.appendChild(div);
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
  const c = getActiveContainer();
  const div = document.createElement("div");
  div.className = "msg-bot-text";
  const rawHtml = marked.parse(text) as string;
  div.innerHTML = sanitizeHtml(rawHtml);
  c.appendChild(div);
  renderMath(div);
  scrollToBottom();
}

function appendError(error: string) {
  const c = getActiveContainer();
  const div = document.createElement("div");
  div.className = "msg-error";
  div.textContent = error;
  c.appendChild(div);
  scrollToBottom();
}

// ── Terminal alert rendering ─────────────────────────────────────

function notifyTerminalAlert(src: string, prompt: string) {
  try {
    if (Notification.permission === "granted") {
      new Notification(`Terminal: ${src}`, { body: prompt, silent: false });
    } else if (Notification.permission !== "denied") {
      Notification.requestPermission();
    }
  } catch { /* Notification API not available */ }

  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;
    gain.gain.value = 0.08;
    osc.start();
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
    osc.stop(ctx.currentTime + 0.15);
  } catch { /* AudioContext not available */ }
}

function handleTerminalEvent(eventType: string, data: any) {
  if (!chatMessages) return;

  const termId: string = data.id;
  const src = data.source === "cursor" ? "Cursor" : data.source === "iterm2" ? "iTerm2" : "Terminal.app";
  const summary: string = data.summary || data.prompt || "...";

  const tab = ensureTab(termId, data.source, data.name, data.command);
  const seq = Number(data.eventSeq ?? 0);
  if (seq > 0 && seq <= tab.lastEventSeq) {
    return;
  }
  if (seq > 0) {
    tab.lastEventSeq = seq;
  }
  tab.lastEvent = data;
  if (data.command) {
    tab.command = data.command;
    tab.label = extractLabel(data.command);
  }

  if (terminalTabs.size === 1 && !activeTabId) {
    switchTab(termId);
  }

  const isAlert = eventType === "terminal_alert";
  if (isAlert) {
    notifyTerminalAlert(src, summary);
  }
  const div = document.createElement("div");
  div.className = isAlert ? "msg-terminal-alert" : "msg-terminal-completed";
  div.dataset.eventSeq = String(data.eventSeq ?? "");
  const rawHtml = marked.parse(summary) as string;

  if (isAlert) {
    div.innerHTML = `
      <div class="terminal-alert-header">
        <span class="terminal-alert-icon">&#9889;</span>
        <span class="terminal-alert-source">${escapeHtml(src)}</span>
      </div>
      <div class="msg-bot-text terminal-event-body">${sanitizeHtml(rawHtml)}</div>
    `;
  } else {
    div.innerHTML = `
      <div class="terminal-completed-header">
        <span class="terminal-completed-icon">&#10003;</span>
        <span class="terminal-completed-source">${escapeHtml(src)}</span>
      </div>
      <div class="msg-bot-text terminal-event-body">${sanitizeHtml(rawHtml)}</div>
    `;
  }

  appendToTab(termId, div);
  renderTabs();
}

function updateTerminalEvent(data: any) {
  if (!chatMessages || !data.eventSeq) return;
  const card = chatMessages.querySelector(`[data-event-seq="${data.eventSeq}"]`);
  if (!card) return;

  const body = card.querySelector(".terminal-event-body");
  if (body && data.summary) {
    const rawHtml = marked.parse(data.summary) as string;
    body.innerHTML = sanitizeHtml(rawHtml);
    scrollToBottom();
  }
}

function handleTerminalList(terminals: any[]) {
  for (const t of terminals) {
    const tab = ensureTab(t.id, t.source, t.name, t.command);
    if (t.command && t.command !== tab.command) {
      tab.command = t.command;
      tab.label = extractLabel(t.command);
    }
  }
  if (terminalTabs.size > 0 && !activeTabId) {
    switchTab(terminalTabs.keys().next().value!);
  }
  renderTabs();
}

// ── Button state ─────────────────────────────────────────────────

function setButtonsEnabled(enabled: boolean) {
  const btn = document.getElementById("sendBtn") as HTMLButtonElement | null;
  if (btn) btn.disabled = !enabled;
  const input = document.getElementById("inputField") as HTMLInputElement | null;
  if (input) input.disabled = !enabled;
}

// ── SSE event handling ───────────────────────────────────────────

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
    case "agent_id":
      setAgentBadge(data);
      break;
    case "done":
      setStatus("Ready", "");
      setButtonsEnabled(true);
      isBusy = false;
      responseTargetTab = null;
      robotState("happy");
      setTimeout(() => robotState("idle"), 2500);
      break;
    case "error":
      setStatus("Error", "error");
      appendError(data);
      setButtonsEnabled(true);
      isBusy = false;
      responseTargetTab = null;
      robotState("error");
      setTimeout(() => robotState("idle"), 3000);
      break;
  }
}

// ── Send message ─────────────────────────────────────────────────

async function sendMessage(text: string) {
  if (isBusy || !text.trim()) return;
  isBusy = true;
  responseTargetTab = activeTabId;
  setButtonsEnabled(false);

  robotState("listening");
  appendUserMsg(text);
  appendBotHeader();
  robotState("thinking");
  setStatus("Thinking...", "thinking");

  const payload: any = { text };

  if (currentAgentId) {
    payload.agentId = currentAgentId;
    if (currentAgentId === "terminal_helper") {
      const ctx = getActiveTerminalContext();
      if (ctx) payload.terminalContext = ctx;
    }
  }

  try {
    const res = await fetch(`${API_BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
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

// ── Terminal events SSE ──────────────────────────────────────────

let terminalEventSource: EventSource | null = null;

function setMonitorStatus(active: boolean) {
  const dot = document.getElementById("monitorDot");
  if (!dot) return;
  if (active) {
    dot.classList.add("active");
    dot.title = "Terminal monitor: active";
  } else {
    dot.classList.remove("active");
    dot.title = "Terminal monitor: off";
  }
}

function startTerminalMonitor() {
  stopTerminalMonitor();


  const evtSource = new EventSource(`${API_BASE}/api/terminal-events`);
  terminalEventSource = evtSource;

  evtSource.onopen = () => setMonitorStatus(true);

  evtSource.onmessage = (e) => {
    try {
      const event = JSON.parse(e.data);
      if (event.type === "terminal_alert" || event.type === "terminal_completed") {
        handleTerminalEvent(event.type, event.data);
      } else if (event.type === "terminal_update") {
        updateTerminalEvent(event.data);
      } else if (event.type === "terminal_list") {
        handleTerminalList(event.data);
      }
    } catch { /* skip */ }
  };

  evtSource.onerror = () => {
    setMonitorStatus(false);
    evtSource.close();
    terminalEventSource = null;
    if (currentAgentId === "terminal_helper") {
      setTimeout(startTerminalMonitor, 5000);
    }
  };

  try {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }
  } catch { /* not available */ }
}

function stopTerminalMonitor() {
  if (terminalEventSource) {
    terminalEventSource.close();
    terminalEventSource = null;
    setMonitorStatus(false);
  }
}

// ── Threadkeeper SSE ─────────────────────────────────────────────

let threadkeeperEventSource: EventSource | null = null;

function startThreadkeeperMonitor() {
  if (threadkeeperEventSource) return;

  const evtSource = new EventSource(`${API_BASE}/api/threadkeeper-events`);
  threadkeeperEventSource = evtSource;

  evtSource.onmessage = (e) => {
    try {
      const event = JSON.parse(e.data);
      if (event.type === "threadkeeper_card" && event.data) {
        renderThreadkeeperCard(event.data as ThreadkeeperCard);
      }
    } catch { /* skip */ }
  };

  evtSource.onerror = () => {
    evtSource.close();
    if (threadkeeperEventSource === evtSource) {
      threadkeeperEventSource = null;
      setTimeout(startThreadkeeperMonitor, 5000);
    }
  };
}

function setupThreadkeeperDock() {
  nextMoveTrigger = document.getElementById("nextMoveTrigger") as HTMLButtonElement | null;
  nextMoveTriggerLabelEl = document.getElementById("nextMoveTriggerLabel");
  threadkeeperDock = document.getElementById("threadkeeperDock");
  threadkeeperShell = document.getElementById("threadkeeperShell");
  threadkeeperSummaryEl = document.getElementById("threadkeeperSummary");
  threadkeeperMetaEl = document.getElementById("threadkeeperMeta");
  threadkeeperTimeEl = document.getElementById("threadkeeperTime");
  threadkeeperFocusEl = document.getElementById("threadkeeperFocus");
  threadkeeperTasksEl = document.getElementById("threadkeeperTasks");
  threadkeeperAvoidEl = document.getElementById("threadkeeperAvoid");
  threadkeeperActionsEl = document.getElementById("threadkeeperActions");
  threadkeeperPanelTitleEl = document.getElementById("threadkeeperPanelTitle");
  const close = document.getElementById("threadkeeperClose");

  nextMoveTrigger?.addEventListener("click", (e) => {
    e.stopPropagation();

    if (threadkeeperOpen && threadkeeperSticky) {
      nextMoveTrigger?.classList.remove("hot");
      setThreadkeeperOpen(false);
      return;
    }

    nextMoveTrigger?.classList.remove("hot");
    void refreshThreadkeeperCard({ open: true, sticky: true });
  });

  close?.addEventListener("click", (e) => {
    e.stopPropagation();
    setThreadkeeperOpen(false);
  });

  document.addEventListener("click", (e) => {
    if (!threadkeeperOpen || !threadkeeperShell) return;
    const target = e.target as Node;
    if (threadkeeperShell.contains(target) || nextMoveTrigger?.contains(target)) {
      return;
    }
    setThreadkeeperOpen(false);
  });

  threadkeeperShell?.addEventListener("mouseenter", () => {
    if (threadkeeperOpen && !threadkeeperSticky) {
      clearThreadkeeperAutoCloseTimer();
    }
  });

  threadkeeperShell?.addEventListener("mouseleave", () => {
    if (threadkeeperOpen && !threadkeeperSticky) {
      scheduleThreadkeeperAutoClose(1800);
    }
  });

  syncThreadkeeperVisibility();
  void refreshThreadkeeperCard();
}

// ── Eye tracking: pupils follow the mouse ────────────────────────

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

function setupRobotClick() {
  const svg = document.querySelector(".robot-svg");
  if (!svg) return;

  svg.addEventListener("click", () => {
    if (isBusy) return;
    robotState("happy");
    setTimeout(() => robotState("idle"), 1500);
  });
}

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

// checkHealth replaced by fetchAgentList

function setupDragRegion() {
  const titlebar = document.querySelector(".titlebar") as HTMLElement | null;
  if (!titlebar) return;

  titlebar.addEventListener("mousedown", (e) => {
    const target = e.target as HTMLElement;
    if (target.closest(".status-badge") || target.closest(".agent-switcher")) return;

    const winId = (window as any).__electrobunWindowId;
    const internalBridge = (window as any).__electrobunInternalBridge;

    if (winId !== undefined && internalBridge) {
      internalBridge.postMessage(JSON.stringify({
        type: "message",
        id: "startWindowMove",
        payload: { id: winId },
      }));
    }
  });

  document.addEventListener("mouseup", () => {
    const internalBridge = (window as any).__electrobunInternalBridge;
    if (internalBridge) {
      internalBridge.postMessage(JSON.stringify({
        type: "message",
        id: "stopWindowMove",
        payload: {},
      }));
    }
  });
}


// ── Initialize ───────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  chatMessages = document.getElementById("chatMessages")!;

  setupEyeTracking();
  setupBlink();
  setupRobotClick();
  setupDragRegion();
  setupThreadkeeperDock();
  startThreadkeeperMonitor();
  fetchAgentList();

  document.getElementById("agentBadge")!.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleAgentMenu();
  });

  document.addEventListener("click", (e) => {
    const switcher = document.getElementById("agentSwitcher");
    if (switcher && !switcher.contains(e.target as Node)) {
      closeAgentMenu();
    }
  });

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

  document.getElementById("resetBtn")!.addEventListener("click", async () => {
    if (isBusy) return;

    const c = getActiveContainer();
    c.innerHTML = '<div class="msg-welcome">Chat cleared.</div>';

    try {
      await fetch(`${API_BASE}/api/reset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: currentAgentId }),
      });
    } catch { /* backend might be down */ }
  });
});
