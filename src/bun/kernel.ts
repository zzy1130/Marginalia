/**
 * Agent kernel — loads AGENT.md + skills/ directory, assembles system prompt.
 * Each agent is a directory under agents/ with an AGENT.md manifest.
 * Sub-skills live in agents/{id}/skills/{name}/SKILL.md and are appended to the prompt.
 */

import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { join } from "path";
import * as yaml from "js-yaml";
import { PROJECT_ROOT } from "./paths";

const AGENTS_DIR = join(PROJECT_ROOT, "agents");

export interface AgentMeta {
  name: string;
  description?: string;
  model?: string;
  runtime?: {
    mode?: "interactive" | "ambient";
    visible_in_chat?: boolean;
    auto_select?: boolean;
  };
  context_match?: {
    app_names?: string[];
    file_types?: string[];
  };
  tools?: string[];
  sandbox?: {
    allowed_file_types?: string[];
    blocked_modules?: string[];
    max_timeout_s?: number;
    can_capture_screen?: boolean;
    network_egress?: string[] | boolean;
    file_write?: string[] | boolean;
  };
  base_prompt: string;
  system_prompt: string;
}

export interface LoadAgentOptions {
  includeSkills?: boolean;
}

const agentCache = new Map<string, AgentMeta>();

export function loadAgent(agentId: string = "pdf_study", options: LoadAgentOptions = {}): AgentMeta {
  const includeSkills = options.includeSkills ?? true;
  const cacheKey = `${agentId}:${includeSkills ? "with-skills" : "base-only"}`;
  const cached = agentCache.get(cacheKey);
  if (cached) return cached;

  const agentPath = join(AGENTS_DIR, agentId, "AGENT.md");
  const text = readFileSync(agentPath, "utf-8");

  const parts = text.split("---", 3);
  if (parts.length < 3) {
    throw new Error(`AGENT.md missing frontmatter: ${agentPath}`);
  }

  const meta = yaml.load(parts[1]) as Record<string, unknown>;
  const basePrompt = parts[2].trim();
  const skillsText = includeSkills ? loadAgentSkills(join(AGENTS_DIR, agentId)) : "";

  const result: AgentMeta = {
    ...(meta as any),
    base_prompt: basePrompt,
    system_prompt: (basePrompt + skillsText).trim(),
  };

  console.log(
    `[kernel] Loaded agent: ${result.name} (${agentId}), mode=${result.runtime?.mode ?? "interactive"}, skills=${includeSkills ? "on" : "off"}, tools=[${(result.tools ?? []).join(", ")}]`,
  );
  agentCache.set(cacheKey, result);
  return result;
}

/** @deprecated Use loadAgent instead */
export const loadSkill = loadAgent;

function loadAgentSkills(agentDir: string): string {
  const skillsDir = join(agentDir, "skills");
  if (!existsSync(skillsDir) || !statSync(skillsDir).isDirectory()) {
    return "";
  }

  const blocks: string[] = [];

  for (const skillName of readdirSync(skillsDir).sort()) {
    const skillMd = join(skillsDir, skillName, "SKILL.md");
    if (!existsSync(skillMd)) continue;

    const text = readFileSync(skillMd, "utf-8");
    const parts = text.split("---", 3);

    if (parts.length >= 3) {
      const fm = (yaml.load(parts[1]) as Record<string, unknown>) ?? {};
      const body = parts[2].trim();
      const name = (fm.name as string) ?? skillName;
      blocks.push(`\n\n## Skill: ${name}\n\n${body}`);
    } else {
      blocks.push(`\n\n## Skill: ${skillName}\n\n${text}`);
    }
  }

  return blocks.join("");
}
