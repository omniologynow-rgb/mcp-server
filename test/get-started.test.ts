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

// Green Room lounge is surfaced + framed as chat-only (never money)
check("autonomous: mentions the Green Room lounge tools", /green_room_/.test(auto) && /lounge/i.test(auto));
check("autonomous: frames lounge as chat-only, no money", /never moves money/i.test(auto));

// Stop path: revoke_entry_vault is surfaced as the hard off-switch, enroll to resume
for (const [label, txt] of [["autonomous", auto], ["proxy", proxy]] as const) {
  check(`${label}: surfaces the stop path (compete only while wanted)`, /stop or pause/i.test(txt) && /Operator/.test(txt));
  check(`${label}: names revoke_entry_vault as the off-switch`, /revoke_entry_vault/.test(txt) && /off-switch/i.test(txt));
  check(`${label}: names enroll_entry_vault to resume`, /enroll_entry_vault/.test(txt));
}

// How-to-play block: the four friction fixes from a real agent's live session
for (const [label, txt] of [["autonomous", auto], ["proxy", proxy]] as const) {
  check(`${label}: says don't filter by time_remaining`, /Don't filter contests by time_remaining/i.test(txt));
  check(`${label}: says don't poll check_payout right after entering`, /Don't call check_payout right after entering/i.test(txt));
  check(`${label}: points at get_my_history for results`, /get_my_history/.test(txt));
  check(`${label}: says no entry fee argument`, /no entry_fee_usdc argument/i.test(txt));
  check(`${label}: warns against raw HTTP/SSE`, /raw HTTP\/SSE/i.test(txt));
}

// Vocab: Connect ID + Balance present; no user-facing "username"; no stray "wallet" copy
check("autonomous: uses Connect ID for agent_id", /Connect ID/.test(auto));
check("autonomous: uses Balance for USDC", /Balance/.test(auto));
for (const [label, txt] of [["autonomous", auto], ["proxy", proxy]] as const) {
  check(`${label}: no user-facing "username"`, !/username/i.test(txt));
  // "wallet" only allowed in the fixed Green Room rule phrase "no wallet strings"
  check(`${label}: no stray "wallet" copy`, !/wallet/i.test(txt.replace(/no wallet strings/gi, "")));
}

console.log(`\nSummary: passed ${passed}, failed ${failed}`);
process.exit(failed > 0 ? 1 : 0);
