/**
 * Tool registry — builds the tool set for an agent based on its AGENT.md manifest.
 *
 * Design: every agent uses `run_code` as its sole tool. The sandbox config
 * from AGENT.md controls what each agent's run_code is allowed to do
 * (blocked modules, timeout). Agent capabilities are defined by skills,
 * not by having different tools.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { createRunCodeTool, type RunCodeSandbox } from "./run-code";

export function buildTools(toolNames: string[], sandbox?: RunCodeSandbox): AgentTool[] {
  const tools: AgentTool[] = [];
  for (const name of toolNames) {
    if (name === "run_code") {
      tools.push(createRunCodeTool(sandbox));
    } else {
      console.warn(`[registry] Unknown tool "${name}", skipping`);
    }
  }
  return tools;
}
