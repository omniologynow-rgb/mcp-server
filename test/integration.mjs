/**
 * Live integration test (mainnet, no funds spent): spawns the built server in
 * AUTONOMOUS mode with a FRESH throwaway keypair and exercises the real flow.
 *
 *  1. tools/list → submit_entry / register_agent descriptions are autonomized
 *  2. register_agent WITHOUT signed_message → server signs in-process →
 *     real (free) registration on mainnet → returns agent_id
 *  3. submit_entry WITHOUT transaction_signature → server signs + broadcasts.
 *     The throwaway wallet has no USDC, so this must fail with the FRIENDLY
 *     "needs USDC" message — which proves the sign+broadcast path works end to
 *     end (everything except funding).
 *
 * Run: node test/integration.mjs   (after npm run build)
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Keypair } from "@solana/web3.js";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0, failed = 0;
const check = (n, c, d = "") => { if (c) { passed++; console.log(`PASS  ${n}${d ? " — " + d : ""}`); } else { failed++; console.log(`FAIL  ${n}${d ? " — " + d : ""}`); } };
const txt = (r) => r?.content?.find((c) => c.type === "text")?.text ?? "";
const json = (r) => { try { return JSON.parse(txt(r)); } catch { return null; } };

const dir = mkdtempSync(join(tmpdir(), "omni-int-"));
const kp = Keypair.generate();
const kpPath = join(dir, "keypair.json");
writeFileSync(kpPath, JSON.stringify(Array.from(kp.secretKey)));
console.log("throwaway wallet:", kp.publicKey.toBase58(), "\n");

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: { ...process.env, OMNIOLOGY_KEYPAIR_PATH: kpPath },
});
const client = new Client({ name: "omni-int-test", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);

try {
  // 1. autonomized tool surface
  const { tools } = await client.listTools();
  const submit = tools.find((t) => t.name === "submit_entry");
  const reg = tools.find((t) => t.name === "register_agent");
  check("submit_entry description is autonomized (no signing instructions)", /handled for you automatically/i.test(submit?.description ?? ""));
  check("register_agent no longer requires wallet_address/signed_message", !(reg?.inputSchema?.required ?? []).includes("signed_message"));
  check("withdraw_to_address exposed in autonomous mode", tools.some((t) => t.name === "withdraw_to_address"));

  // withdraw_to_address: validation (bad address → friendly error, no broadcast)
  const badW = json(await client.callTool({ name: "withdraw_to_address", arguments: { amount_usdc: 1, destination_address: "not-an-address" } })) ?? { _raw: txt(await client.callTool({ name: "withdraw_to_address", arguments: { amount_usdc: 1, destination_address: "nope" } })) };
  // unfunded throwaway wallet → no USDC to withdraw (friendly), proving the path runs
  const wRes = await client.callTool({ name: "withdraw_to_address", arguments: { amount_usdc: 0.01, destination_address: kp.publicKey.toBase58() } });
  const wText = txt(wRes);
  console.log("\nwithdraw_to_address (unfunded) result:\n  ", wText.slice(0, 160), "\n");
  check("withdraw rejects invalid address (validation)", /not a valid/i.test(JSON.stringify(badW)));
  check("withdraw on unfunded wallet → friendly no-USDC", /no USDC/i.test(wText));
  void reg;

  // 2. autonomous registration (free, real mainnet)
  const regRes = await client.callTool({
    name: "register_agent",
    arguments: {
      email: `mcp-int-${kp.publicKey.toBase58().slice(0, 8).toLowerCase()}@example.com`,
      terms_of_service_accepted: true,
      display_name: "mcp-int-test",
    },
  });
  const regJson = json(regRes);
  const agentId = regJson?.agent_id;
  check("register_agent (autonomous sign) returns an agent_id", !!agentId, agentId ?? txt(regRes).slice(0, 120));

  // 3. autonomous submit_entry → sign + broadcast → friendly no-USDC failure
  let contestId = null;
  for (let i = 0; i < 30 && !contestId; i++) {
    const cs = json(await client.callTool({ name: "list_active_contests", arguments: {} }))?.contests ?? [];
    const c = cs.filter((x) => (x.time_remaining_seconds ?? 0) > 20).sort((a, b) => b.time_remaining_seconds - a.time_remaining_seconds)[0];
    if (c) contestId = c.contest_id; else await new Promise((r) => setTimeout(r, 4000));
  }
  if (contestId && agentId) {
    const sub = await client.callTool({ name: "submit_entry", arguments: { contest_id: contestId, agent_id: agentId, payload: "integration test entry [no funds] — proving the autonomous signing path" } });
    const t = txt(sub);
    console.log("\nsubmit_entry result:\n  ", t.slice(0, 240), "\n");
    // Expect a friendly funding error (proves sign+broadcast ran and only funding is missing).
    const friendlyFunding = /USDC/i.test(t) && /(don't need SOL|send a small amount|enough USDC|received any USDC)/i.test(t);
    check("autonomous submit_entry signs+broadcasts; fails only on missing USDC (friendly)", friendlyFunding, friendlyFunding ? "" : "unexpected: " + t.slice(0, 160));
  } else {
    check("autonomous submit_entry path", false, "could not get a contest_id/agent_id to test");
  }
} finally {
  await client.close();
}

console.log(`\nSummary: passed ${passed}, failed ${failed}`);
process.exit(failed > 0 ? 1 : 0);
