import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { observeDesktop, type DesktopObservation } from "./desktop-observation";
import { PROJECT_ROOT, VENV_PYTHON } from "./paths";
import { captureContext, type ScreenContext } from "./screen";
import { loadAgent } from "./kernel";

const STATE_PATH = join(PROJECT_ROOT, ".threadkeeper_state.json");
const TERMINAL_SCRIPT = join(PROJECT_ROOT, "core", "terminal.py");
const MIN_CARD_INTERVAL_MS = 90_000;
const MAX_RECENT_CARDS = 4;
const THREADKEEPER_META = loadAgent("threadkeeper", { includeSkills: false });

interface TerminalStatusItem {
  source: string;
  id: string;
  name?: string;
  command?: string;
  active?: boolean;
  is_ai?: boolean;
  needs_input?: boolean;
  prompt?: string;
}

interface TerminalSummary {
  activeAiCount: number;
  waitingCount: number;
  activeLabels: string[];
  waitingLabels: string[];
  fingerprint: string;
}

export interface ThreadkeeperAction {
  id: string;
  label: string;
  kind: "switch_agent" | "prompt";
  agentId?: "pdf_study" | "terminal_helper";
  prompt?: string;
}

export interface ThreadkeeperCard {
  id: string;
  title: string;
  summary: string;
  focus: string;
  details: string[];
  accent: "terminal" | "document" | "context";
  urgency: "low" | "medium" | "high";
  nextMove: string;
  whyNow: string;
  tasks: string[];
  avoid: string[];
  actions: ThreadkeeperAction[];
  fingerprint: string;
  timestamp: number;
}

interface ThreadkeeperState {
  lastCardTime: number;
  lastCardFingerprint: string;
  lastFocusFingerprint: string;
  lastFocusLabel: string;
  lastDocumentFingerprint: string;
  lastTerminalFingerprint: string;
  recentCards: ThreadkeeperCard[];
}

interface ThreadkeeperSnapshot {
  focusFingerprint: string;
  focusLabel: string;
  focusSource: "observation" | "document" | "terminal" | "unavailable";
  focusCategory: string;
  focusApp: string;
  documentFingerprint: string;
  docContext: ScreenContext;
  terminals: TerminalSummary;
  previousFocusLabel: string;
  observed: boolean;
}

const DEFAULT_STATE: ThreadkeeperState = {
  lastCardTime: 0,
  lastCardFingerprint: "",
  lastFocusFingerprint: "",
  lastFocusLabel: "",
  lastDocumentFingerprint: "",
  lastTerminalFingerprint: "",
  recentCards: [],
};

function loadState(): ThreadkeeperState {
  try {
    if (existsSync(STATE_PATH)) {
      const data = JSON.parse(readFileSync(STATE_PATH, "utf-8")) as Partial<ThreadkeeperState>;
      return {
        ...DEFAULT_STATE,
        ...data,
        recentCards: Array.isArray(data.recentCards) ? data.recentCards.slice(0, MAX_RECENT_CARDS) : [],
      };
    }
  } catch {
    // ignore
  }
  return { ...DEFAULT_STATE };
}

function saveState(state: ThreadkeeperState) {
  try {
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch {
    // ignore
  }
}

function trimTitle(title: string): string {
  const normalized = title.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length > 64 ? `${normalized.slice(0, 61)}...` : normalized;
}

function pushUnique(list: string[], value: string | null | undefined) {
  if (!value || list.includes(value)) return;
  list.push(value);
}

function buildFocusFingerprint(app: string, category: string, title: string): string {
  const includeTitle = ["coding", "terminal", "writing", "reading", "presenting"].includes(category);
  const shortTitle = includeTitle ? trimTitle(title) : "";
  return [category, app, shortTitle].filter(Boolean).join("::");
}

function formatDocumentLabel(screen: ScreenContext): string | null {
  if (screen.status !== "ok" || !screen.filename) return null;
  const page = screen.current_page != null ? ` 第 ${screen.current_page} 页` : "";
  return `${screen.filename}${page}`;
}

function isMarginaliaAppName(value: string | null | undefined): boolean {
  return /marginalia/i.test((value ?? "").trim());
}

function isMarginaliaFocusLabel(value: string | null | undefined): boolean {
  return /marginalia/i.test((value ?? "").trim());
}

function extractDocumentTopic(screen: ScreenContext): string | null {
  if (screen.status !== "ok" || !screen.page_text) return null;

  const lines = screen.page_text
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  for (const line of lines.slice(0, 12)) {
    if (line.length < 5 || line.length > 72) continue;
    if (/^[\d\s./:-]+$/.test(line)) continue;
    if (/^(page|slide|lecture)\b/i.test(line) && line.length < 18) continue;
    if (/^[A-Z0-9 _-]+$/.test(line) && line.length < 10) continue;
    return line;
  }

  return null;
}

function pickTerminalLabel(term: TerminalStatusItem): string {
  const raw = (term.command || term.name || "").trim();
  if (!raw) return term.id.split(":").slice(-1)[0] || term.source;
  const compact = raw.replace(/\s+/g, " ");
  return compact.length > 28 ? `${compact.slice(0, 25)}...` : compact;
}

async function readTerminalSummary(): Promise<TerminalSummary> {
  try {
    const proc = Bun.spawn([VENV_PYTHON, TERMINAL_SCRIPT, "status"], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
      env: {
        ...(process.env as Record<string, string>),
        DYLD_FALLBACK_LIBRARY_PATH: "/opt/homebrew/lib",
      },
    });

    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      return {
        activeAiCount: 0,
        waitingCount: 0,
        activeLabels: [],
        waitingLabels: [],
        fingerprint: "terminal:error",
      };
    }

    const items = JSON.parse(stdout) as TerminalStatusItem[];
    const active = items.filter((item) => item.is_ai && item.active);
    const waiting = items.filter((item) => item.needs_input);

    const activeLabels = active.slice(0, 2).map(pickTerminalLabel);
    const waitingLabels = waiting.slice(0, 2).map(pickTerminalLabel);

    return {
      activeAiCount: active.length,
      waitingCount: waiting.length,
      activeLabels,
      waitingLabels,
      fingerprint: [
        active.length,
        waiting.length,
        activeLabels.join("|"),
        waitingLabels.join("|"),
      ].join("::"),
    };
  } catch {
    return {
      activeAiCount: 0,
      waitingCount: 0,
      activeLabels: [],
      waitingLabels: [],
      fingerprint: "terminal:exception",
    };
  }
}

function formatObservationFocus(observation: DesktopObservation | null): { label: string; fingerprint: string } | null {
  if (!observation || observation.status !== "ok") {
    return null;
  }

  const title = trimTitle(observation.active_window.title);
  const label = title
    ? `${observation.active_window.app_name} · ${title}`
    : observation.active_window.app_name || observation.activity.category;

  return {
    label,
    fingerprint: buildFocusFingerprint(
      observation.active_window.app_name,
      observation.activity.category,
      observation.active_window.title,
    ),
  };
}

function formatTerminalFocus(terminals: TerminalSummary): { label: string; fingerprint: string } | null {
  if (terminals.waitingCount > 0) {
    const suffix = terminals.waitingLabels[0] ? ` · ${terminals.waitingLabels[0]}` : "";
    return {
      label: `AI 终端等待确认${suffix}`,
      fingerprint: `terminal:waiting:${terminals.fingerprint}`,
    };
  }

  if (terminals.activeAiCount > 0) {
    const suffix = terminals.activeLabels[0] ? ` · ${terminals.activeLabels[0]}` : "";
    return {
      label: `AI 终端运行中${suffix}`,
      fingerprint: `terminal:active:${terminals.fingerprint}`,
    };
  }

  return null;
}

async function gatherSnapshot(state: ThreadkeeperState): Promise<ThreadkeeperSnapshot> {
  const [observation, docContext, terminals] = await Promise.all([
    observeDesktop(),
    captureContext({ includeImage: false }),
    readTerminalSummary(),
  ]);

  const observedFocus = formatObservationFocus(observation);
  const docLabel = formatDocumentLabel(docContext);
  const terminalFocus = formatTerminalFocus(terminals);
  let focusSource: ThreadkeeperSnapshot["focusSource"] = "unavailable";
  let focusCategory = "idle";
  let focusApp = "";
  let focusLabel = "桌面上下文不可用";
  let focusFingerprint = `unavailable:${observation?.status ?? "missing"}`;

  const internalObservation = observation?.status === "ok" && isMarginaliaAppName(observation.active_window.app_name);

  if (observedFocus && !internalObservation) {
    focusSource = "observation";
    focusCategory = observation?.activity.category ?? "desktop";
    focusApp = observation?.active_window.app_name ?? "";
    focusLabel = observedFocus.label;
    focusFingerprint = observedFocus.fingerprint;
  } else if (docLabel) {
    focusSource = "document";
    focusCategory = "document";
    focusApp = docContext.app_name || "Document";
    focusLabel = docLabel;
    focusFingerprint = `document:${docContext.filename ?? ""}:${docContext.current_page ?? ""}`;
  } else if (terminalFocus) {
    focusSource = "terminal";
    focusCategory = "terminal";
    focusApp = "AI Terminal";
    focusLabel = terminalFocus.label;
    focusFingerprint = terminalFocus.fingerprint;
  }

  const documentFingerprint = docContext.status === "ok"
    ? `${docContext.filename ?? ""}:${docContext.current_page ?? ""}`
    : docContext.status;

  return {
    focusFingerprint,
    focusLabel,
    focusSource,
    focusCategory,
    focusApp,
    documentFingerprint,
    docContext,
    terminals,
    previousFocusLabel: state.lastFocusLabel,
    observed: Boolean((observedFocus && !internalObservation) || docLabel || terminalFocus),
  };
}

function buildTaskList(snapshot: ThreadkeeperSnapshot): string[] {
  const tasks: string[] = [];
  const docLabel = formatDocumentLabel(snapshot.docContext);
  const docTopic = extractDocumentTopic(snapshot.docContext);

  if (snapshot.terminals.waitingCount > 0) {
    const suffix = snapshot.terminals.waitingLabels[0] ? `: ${snapshot.terminals.waitingLabels[0]}` : "";
    pushUnique(tasks, `处理 ${snapshot.terminals.waitingCount} 个等待确认的终端${suffix}`);
  } else if (snapshot.terminals.activeAiCount > 0 && !docLabel && (snapshot.focusSource === "terminal" || snapshot.focusCategory === "coding")) {
    const suffix = snapshot.terminals.activeLabels[0] ? `: ${snapshot.terminals.activeLabels[0]}` : "";
    pushUnique(tasks, `跟进 ${snapshot.terminals.activeAiCount} 个运行中的 AI 终端${suffix}`);
  }

  if (docLabel) {
    if (snapshot.focusCategory === "coding") {
      pushUnique(tasks, docTopic ? `把 ${docTopic} 落到当前实现` : `把 ${docLabel} 的内容落到当前实现`);
    } else {
      pushUnique(tasks, docTopic ? `先吃透 ${docTopic}` : `继续推进 ${docLabel}`);
    }
  }

  if (snapshot.focusCategory === "coding" && snapshot.focusApp && !isMarginaliaAppName(snapshot.focusApp)) {
    pushUnique(tasks, `继续在 ${snapshot.focusApp} 里推进当前修改`);
  } else if (snapshot.focusSource === "terminal") {
    pushUnique(tasks, "先看清终端最新输出再决定下一步");
  } else if (!docLabel && snapshot.focusLabel && snapshot.focusLabel !== "桌面上下文不可用" && !isMarginaliaFocusLabel(snapshot.focusLabel)) {
    pushUnique(tasks, `续上 ${snapshot.focusLabel} 这条线程`);
  }

  if (tasks.length === 0) {
    pushUnique(tasks, "先确认当前最重要的一件事");
  }

  return tasks.slice(0, 2);
}

function buildAvoidList(snapshot: ThreadkeeperSnapshot): string[] {
  const avoid: string[] = [];
  const docLabel = formatDocumentLabel(snapshot.docContext);
  const docTopic = extractDocumentTopic(snapshot.docContext);

  if (snapshot.terminals.waitingCount > 0) {
    pushUnique(avoid, "不要继续切任务，先处理正在等待确认的终端");
  }

  if (snapshot.terminals.activeAiCount > 1 && !docLabel) {
    pushUnique(avoid, "不要同时追多个 AI 终端，容易丢上下文");
  }

  if (docLabel && snapshot.focusCategory === "coding") {
    pushUnique(avoid, docTopic ? `不要脱离 ${docTopic} 直接改代码` : `不要脱离 ${docLabel} 的语境直接改代码`);
  }

  if (snapshot.docContext.status === "ok" && snapshot.docContext.current_page == null) {
    pushUnique(avoid, "如果要插入笔记，先确认页码");
  }

  if (!docLabel && snapshot.focusSource === "terminal" && snapshot.terminals.activeAiCount > 0 && snapshot.terminals.waitingCount === 0) {
    pushUnique(avoid, "不要重复发送同一个请求，先看终端最新输出");
  }

  return avoid.slice(0, 1);
}

function buildNextMove(snapshot: ThreadkeeperSnapshot): {
  nextMove: string;
  whyNow: string;
  urgency: ThreadkeeperCard["urgency"];
} {
  const docLabel = formatDocumentLabel(snapshot.docContext);
  const docTopic = extractDocumentTopic(snapshot.docContext);

  if (snapshot.terminals.waitingCount > 0) {
    return {
      nextMove: snapshot.terminals.waitingCount === 1 ? "先处理终端确认" : `先清掉 ${snapshot.terminals.waitingCount} 个终端确认`,
      whyNow: snapshot.terminals.waitingLabels[0]
        ? `${snapshot.terminals.waitingLabels[0]} 正在等你给决定`
        : "AI 终端正在等待你的输入",
      urgency: "high",
    };
  }

  if (docLabel && snapshot.focusCategory === "coding") {
    return {
      nextMove: docTopic ? `先把 ${docTopic} 落到代码里` : `先把 ${docLabel} 和当前代码改动对齐`,
      whyNow: docLabel,
      urgency: "medium",
    };
  }

  if (docLabel) {
    return {
      nextMove: docTopic ? `先抓住 ${docTopic}` : `先续上 ${docLabel}`,
      whyNow: docLabel,
      urgency: "medium",
    };
  }

  if (snapshot.terminals.activeAiCount > 0) {
    return {
      nextMove: "先看终端最新输出",
      whyNow: `${snapshot.terminals.activeAiCount} 个 AI 终端还在运行`,
      urgency: "medium",
    };
  }

  if (snapshot.focusLabel === "桌面上下文不可用" || isMarginaliaFocusLabel(snapshot.focusLabel)) {
    return {
      nextMove: "先确认当前最重要的一件事",
      whyNow: "当前上下文不够稳定，先收敛到一条主线",
      urgency: "low",
    };
  }

  return {
    nextMove: `先续上 ${snapshot.focusLabel}`,
    whyNow: "先收敛到一条任务线",
    urgency: "low",
  };
}

function buildActions(snapshot: ThreadkeeperSnapshot): ThreadkeeperAction[] {
  const actions: ThreadkeeperAction[] = [];
  const docLabel = formatDocumentLabel(snapshot.docContext);
  const docTopic = extractDocumentTopic(snapshot.docContext);

  if (snapshot.terminals.waitingCount > 0) {
    actions.push(
      { id: "open-term", label: "打开 TERM", kind: "switch_agent", agentId: "terminal_helper" },
      {
        id: "draft-reply",
        label: "起草回复",
        kind: "prompt",
        agentId: "terminal_helper",
        prompt: "根据当前终端上下文，先给我一版简短、安全的回复草稿，并标出需要我确认的地方。",
      },
    );
  }

  if (docLabel && snapshot.focusCategory === "coding") {
    actions.push({
      id: "connect-code",
      label: "落到代码",
      kind: "prompt",
      agentId: "pdf_study",
      prompt: "结合当前 PDF 页面和我现在的实现上下文，告诉我接下来三步该做什么，并提醒我最容易犯的两个错误。",
    });
  } else if (docLabel) {
    actions.push({
      id: "summarize-page",
      label: docTopic ? "这页在讲什么" : "总结这页",
      kind: "prompt",
      agentId: "pdf_study",
      prompt: "总结我现在在干哪几件事情，并提醒我最容易犯的两个错误。",
    });
  }

  actions.push({
    id: "avoid-mistakes",
    label: "提醒易错点",
    kind: "prompt",
    agentId: docLabel ? "pdf_study" : undefined,
    prompt: "结合当前上下文，总结我现在在干哪几件事情，并提醒我最容易犯的两个错误。",
  });

  return actions
    .filter((action, index, arr) => arr.findIndex((other) => other.id === action.id) === index)
    .slice(0, 3);
}

export function getRecentThreadkeeperCards(): ThreadkeeperCard[] {
  return loadState().recentCards;
}

export interface ThreadkeeperResult {
  observed: boolean;
  emitted: boolean;
  card?: ThreadkeeperCard;
}

interface BuildThreadkeeperCardOptions {
  forceBaseline?: boolean;
}

interface UpdateStateOptions {
  persistCard?: boolean;
}

function buildBaselineSummary(
  snapshot: ThreadkeeperSnapshot,
  docLabel: string | null,
): Pick<ThreadkeeperCard, "summary" | "accent"> {
  if (snapshot.terminals.waitingCount > 0) {
    return {
      summary: snapshot.terminals.waitingCount === 1
        ? "当前有 1 个终端确认待处理"
        : `当前有 ${snapshot.terminals.waitingCount} 个终端确认待处理`,
      accent: "terminal",
    };
  }

  if (docLabel && snapshot.focusCategory === "coding") {
    return {
      summary: `当前在把 ${docLabel} 落到实现`,
      accent: "document",
    };
  }

  if (docLabel) {
    return {
      summary: `当前在推进 ${docLabel}`,
      accent: "document",
    };
  }

  if (snapshot.terminals.activeAiCount > 0) {
    return {
      summary: snapshot.terminals.activeAiCount === 1
        ? "当前有 1 个 AI 终端在运行"
        : `当前有 ${snapshot.terminals.activeAiCount} 个 AI 终端在运行`,
      accent: "terminal",
    };
  }

  if (snapshot.focusLabel !== "桌面上下文不可用") {
    return {
      summary: `当前在处理 ${snapshot.focusLabel}`,
      accent: "context",
    };
  }

  return {
    summary: "当前没有待确认事项",
    accent: "context",
  };
}

function buildThreadkeeperCard(
  snapshot: ThreadkeeperSnapshot,
  state: ThreadkeeperState,
  options: BuildThreadkeeperCardOptions = {},
): ThreadkeeperCard | null {
  const { forceBaseline = false } = options;
  const now = Date.now();
  const focusChanged = snapshot.focusFingerprint !== state.lastFocusFingerprint;
  const documentChanged = snapshot.documentFingerprint !== state.lastDocumentFingerprint;
  const terminalChanged = snapshot.terminals.fingerprint !== state.lastTerminalFingerprint;
  const hasTerminalDecision = snapshot.terminals.waitingCount > 0;

  if (!forceBaseline && !focusChanged && !documentChanged && !terminalChanged) {
    return null;
  }

  if (!forceBaseline && !snapshot.observed && !hasTerminalDecision) {
    return null;
  }

  if (!forceBaseline && !hasTerminalDecision && now - state.lastCardTime < MIN_CARD_INTERVAL_MS) {
    return null;
  }

  const docLabel = formatDocumentLabel(snapshot.docContext);
  const details: string[] = [];
  const tasks = buildTaskList(snapshot);
  const avoid = buildAvoidList(snapshot);
  const { nextMove, whyNow, urgency } = buildNextMove(snapshot);
  const actions = buildActions(snapshot);
  let summary = `你切到了 ${snapshot.focusLabel}`;
  let accent: ThreadkeeperCard["accent"] = "context";

  if (forceBaseline) {
    const baseline = buildBaselineSummary(snapshot, docLabel);
    summary = baseline.summary;
    accent = baseline.accent;
  } else if (hasTerminalDecision && (terminalChanged || snapshot.focusSource === "terminal")) {
    summary = `有 ${snapshot.terminals.waitingCount} 个终端决策在等你`;
    accent = "terminal";
  } else if (docLabel && documentChanged) {
    summary = `刚回到 ${docLabel}`;
    accent = "document";
  } else if (snapshot.focusSource === "terminal" && terminalChanged) {
    summary = snapshot.terminals.activeAiCount > 0
      ? `有 ${snapshot.terminals.activeAiCount} 个 AI 终端还在跑`
      : summary;
    accent = "terminal";
  }

  details.push(`当前: ${snapshot.focusLabel}`);

  if (snapshot.previousFocusLabel && snapshot.previousFocusLabel !== snapshot.focusLabel) {
    details.push(`刚才: ${snapshot.previousFocusLabel}`);
  }

  if (docLabel) {
    details.push(`文档: ${docLabel}`);
  }

  if (snapshot.terminals.waitingCount > 0) {
    const suffix = snapshot.terminals.waitingLabels.length > 0
      ? ` · ${snapshot.terminals.waitingLabels.join(" / ")}`
      : "";
    details.push(`终端: ${snapshot.terminals.waitingCount} 个等待确认${suffix}`);
  } else if (snapshot.terminals.activeAiCount > 0) {
    const suffix = snapshot.terminals.activeLabels.length > 0
      ? ` · ${snapshot.terminals.activeLabels.join(" / ")}`
      : "";
    details.push(`终端: ${snapshot.terminals.activeAiCount} 个 AI 终端运行中${suffix}`);
  }

  const fingerprint = [
    forceBaseline ? "baseline" : summary,
    snapshot.focusFingerprint,
    snapshot.documentFingerprint,
    snapshot.terminals.fingerprint,
  ].join("::");

  if (!forceBaseline && fingerprint === state.lastCardFingerprint) {
    return null;
  }

  return {
    id: `${now}`,
    title: THREADKEEPER_META.name,
    summary,
    focus: snapshot.focusLabel,
    details: details.slice(0, 4),
    accent,
    urgency,
    nextMove,
    whyNow,
    tasks,
    avoid,
    actions,
    fingerprint,
    timestamp: now,
  };
}

function updateState(
  state: ThreadkeeperState,
  snapshot: ThreadkeeperSnapshot,
  card?: ThreadkeeperCard | null,
  options: UpdateStateOptions = {},
) {
  const persistCard = options.persistCard ?? true;
  state.lastFocusFingerprint = snapshot.focusFingerprint;
  state.lastFocusLabel = snapshot.focusLabel;
  state.lastDocumentFingerprint = snapshot.documentFingerprint;
  state.lastTerminalFingerprint = snapshot.terminals.fingerprint;

  if (card && persistCard) {
    state.lastCardTime = card.timestamp;
    state.lastCardFingerprint = card.fingerprint;
    state.recentCards = [card, ...state.recentCards]
      .filter((item, index, arr) => arr.findIndex((other) => other.id === item.id) === index)
      .slice(0, MAX_RECENT_CARDS);
  }
}

export async function getThreadkeeperBaselineCard(): Promise<ThreadkeeperCard | null> {
  const state = loadState();
  const snapshot = await gatherSnapshot(state);
  const card = buildThreadkeeperCard(snapshot, state, { forceBaseline: true });
  updateState(state, snapshot, null, { persistCard: false });
  saveState(state);
  return card;
}

export async function runThreadkeeperCycle(pushFn: (card: ThreadkeeperCard) => void): Promise<ThreadkeeperResult> {
  const state = loadState();
  const snapshot = await gatherSnapshot(state);
  const card = buildThreadkeeperCard(snapshot, state);
  updateState(state, snapshot, card);
  saveState(state);

  if (!card) {
    return { observed: snapshot.observed, emitted: false };
  }

  pushFn(card);
  console.log(`[threadkeeper] ${card.summary}`);
  return { observed: snapshot.observed, emitted: true, card };
}
