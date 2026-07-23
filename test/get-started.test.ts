/**
 * Unit tests for get-started.ts (pure). Run via npm run test:unit.
 */
import { GET_STARTED_TOOL, buildGetStartedText } from "../src/get-started.js";

let passed = 0, failed = 0;
const check = (n: string, c: boolean, d = "") => {
  if (c) { passed++; console.log(`  ✓ ${n}`); }
  else { failed++; console.log(`  ✗ ${n}${d ? " — " + d : ""}`); }
};

console.log("get-started.ts unit tests");

// Tool shape
check("tool name is get_started", GET_STARTED_TOOL.name === "get_started");
check("tool takes no input", Object.keys((GET_STARTED_TOOL.inputSchema.properties ?? {})).length === 0);
check("description says START HERE", /START HERE/.test(GET_STARTED_TOOL.description ?? ""));

// Autonomous (local key) playbook
const auto = buildGetStartedText(true);
check("autonomous: states AUTONOMOUS mode", /AUTONOMOUS mode/.test(auto));
check("autonomous: names the 3 core calls", auto.includes("list_active_contests") && auto.includes("submit_entry") && auto.includes("check_payout"));
check("autonomous: forbids constructing/signing a tx", /Do NOT construct.*sign a Solana transaction/s.test(auto));
check("autonomous: forbids running the server yourself", /Do NOT run or spawn this MCP server yourself/.test(auto));
check("autonomous: points at get_agent_status for readiness", auto.includes("get_agent_status"));

// Proxy (no key) playbook
const proxy = buildGetStartedText(false);
check("proxy: states PROXY mode", /PROXY mode/.test(proxy));
check("proxy: mentions the Entry Vault keyless path", /Entry Vault/.test(proxy));
check("proxy: still forbids hand-signing", /Do NOT construct.*sign a Solana transaction/s.test(proxy));

// Host-neutral: no chat/GPT-only phrasing that confuses autonomous agents
for (const [label, txt] of [["autonomous", auto], ["proxy", proxy]] as const) {
  check(`${label}: host-neutral (no "in the chat" / GPT-only phrasing)`, !/in the chat|ChatGPT|custom GPT|type in chat/i.test(txt));
}

console.log(`\nSummary: passed ${passed}, failed ${failed}`);
process.exit(failed > 0 ? 1 : 0);
