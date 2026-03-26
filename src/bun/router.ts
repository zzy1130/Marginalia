/**
 * Agent router — discovers agents and selects the right one based on context.
 * Scans agents/ directory, reads AGENT.md frontmatter, matches on active app/file.
 */

import { readdirSync, readFileSync, existsSync, statSync } from "fs";
import { join } from "path";
import * as yaml from "js-yaml";
import { PROJECT_ROOT } from "./paths";

const AGENTS_DIR = join(PROJECT_ROOT, "agents");

interface AgentEntry {
  id: string;
  name: string;
  description: string;
  runtime?: {
    mode?: "interactive" | "ambient";
    visible_in_chat?: boolean;
    auto_select?: boolean;
  };
  context_match?: {
    app_names?: string[];
    file_types?: string[];
  };
}

let agentCache: AgentEntry[] | null = null;

function isInteractiveAgent(agent: AgentEntry): boolean {
  return agent.runtime?.mode !== "ambient";
}

function isVisibleInChat(agent: AgentEntry): boolean {
  return isInteractiveAgent(agent) && agent.runtime?.visible_in_chat !== false;
}

function canAutoSelect(agent: AgentEntry): boolean {
  return isInteractiveAgent(agent) && agent.runtime?.auto_select !== false;
}

export function discoverAgents(): AgentEntry[] {
  if (agentCache) return agentCache;

  const agents: AgentEntry[] = [];

  for (const dir of readdirSync(AGENTS_DIR).sort()) {
    const agentMd = join(AGENTS_DIR, dir, "AGENT.md");
    if (!existsSync(agentMd) || !statSync(join(AGENTS_DIR, dir)).isDirectory()) continue;

    try {
      const text = readFileSync(agentMd, "utf-8");
      const parts = text.split("---", 3);
      if (parts.length < 3) continue;

      const meta = yaml.load(parts[1]) as Record<string, any>;
      agents.push({
        id: dir,
        name: meta.name ?? dir,
        description: meta.description ?? "",
        runtime: meta.runtime,
        context_match: meta.context_match,
      });
    } catch (err) {
      console.warn(`[router] Failed to read ${agentMd}:`, err);
    }
  }

  agentCache = agents;
  console.log(`[router] Discovered ${agents.length} agents: ${agents.map(a => a.id).join(", ")}`);
  return agents;
}

export function selectAgent(appName?: string, fileName?: string): string {
  const agents = discoverAgents().filter(canAutoSelect);

  if (appName) {
    for (const agent of agents) {
      if (agent.context_match?.app_names?.includes(appName)) {
        return agent.id;
      }
    }
  }

  if (fileName) {
    const lower = fileName.toLowerCase();
    for (const agent of agents) {
      if (agent.context_match?.file_types?.some(ext => lower.endsWith(ext))) {
        return agent.id;
      }
    }
  }

  const fallback = agents.find((agent) => agent.id === "pdf_study") ?? agents[0];
  return fallback?.id ?? "pdf_study";
}

export function listAgents(): { id: string; name: string; description: string }[] {
  return discoverAgents()
    .filter(isVisibleInChat)
    .map(({ id, name, description }) => ({ id, name, description }));
}
