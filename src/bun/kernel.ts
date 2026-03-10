/**
 * Skill kernel — loads SKILL.md + skills/ directory, assembles system prompt.
 * Port of core/agent.py's _load_skill() + _load_agent_skills() to TypeScript.
 */

import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { join } from "path";
import * as yaml from "js-yaml";
import { PROJECT_ROOT } from "./paths";

const AGENTS_DIR = join(PROJECT_ROOT, "agents");

export interface SkillMeta {
  name: string;
  description?: string;
  context_match?: {
    app_names?: string[];
    file_types?: string[];
  };
  sandbox?: {
    allowed_file_types?: string[];
    blocked_modules?: string[];
    max_timeout_s?: number;
    can_capture_screen?: boolean;
    network_egress?: string[];
  };
  system_prompt: string;
}

let skillCache: SkillMeta | null = null;
let skillCacheId: string | null = null;

export function loadSkill(agentId: string = "pdf_study"): SkillMeta {
  if (skillCache && skillCacheId === agentId) return skillCache;

  const skillPath = join(AGENTS_DIR, agentId, "SKILL.md");
  const text = readFileSync(skillPath, "utf-8");

  const parts = text.split("---", 3);
  if (parts.length < 3) {
    throw new Error(`SKILL.md missing frontmatter: ${skillPath}`);
  }

  const meta = yaml.load(parts[1]) as Record<string, unknown>;
  const basePrompt = parts[2].trim();
  const skillsText = loadAgentSkills(join(AGENTS_DIR, agentId));

  const result: SkillMeta = {
    ...(meta as any),
    system_prompt: basePrompt + skillsText,
  };

  console.log(`[kernel] Loaded skill: ${result.name} (${agentId})`);
  skillCache = result;
  skillCacheId = agentId;
  return result;
}

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
