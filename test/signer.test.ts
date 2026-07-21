/**
 * Unit tests for signer.ts (pure parts — no network). Run: npm run test:unit
 */
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import { loadKeypairFromPath, buildRegisterProof, friendlyBroadcastError, injectAgentId, toolTakesAgentId, REGISTER_DOMAIN } from "../src/signer.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

let passed = 0, failed = 0;
const check = (n: string, c: boolean, d = "") => {
  if (c) { passed++; console.log(`  ✓ ${n}`); }
  else { failed++; console.log(`  ✗ ${n}${d ? " — " + d : ""}`); }
};

console.log("signer.ts unit tests");

const dir = mkdtempSync(join(tmpdir(), "omni-signer-"));

// loadKeypairFromPath
check("unset path → null (proxy mode)", loadKeypairFromPath(undefined) === null && loadKeypairFromPath("") === null);

const kp = Keypair.generate();
const good = join(dir, "keypair.json");
writeFileSync(good, JSON.stringify(Array.from(kp.secretKey)));
const loaded = loadKeypairFromPath(good);
check("valid 64-byte keypair file loads", !!loaded && loaded.publicKey === kp.publicKey.toBase58());

const bad = join(dir, "bad.json");
writeFileSync(bad, "not json");
let threwBad = false;
try { loadKeypairFromPath(bad); } catch { threwBad = true; }
check("invalid JSON file throws friendly error", threwBad);

const wrongLen = join(dir, "wrong.json");
writeFileSync(wrongLen, JSON.stringify([1, 2, 3]));
let threwLen = false;
try { loadKeypairFromPath(wrongLen); } catch { threwLen = true; }
check("wrong-length array throws", threwLen);

let threwMissing = false;
try { loadKeypairFromPath(join(dir, "nope.json")); } catch { threwMissing = true; }
check("missing file throws friendly error", threwMissing);

// buildRegisterProof — signature must verify against the message bytes
const ts = 1_700_000_000;
const proof = buildRegisterProof(kp, ts);
check("message_body format", proof.message_body === `${REGISTER_DOMAIN}:${kp.publicKey.toBase58()}:${ts}`);
check("wallet_address is the keypair pubkey", proof.wallet_address === kp.publicKey.toBase58());
const sigValid = ed25519.verify(
  bs58.decode(proof.signed_message),
  new TextEncoder().encode(proof.message_body),
  kp.publicKey.toBytes(),
);
check("signed_message is a valid ed25519 sig over message_body", sigValid);

// friendlyBroadcastError — plain English, no raw jargon for the common case
check("insufficient-USDC error is plain English", /usdc/i.test(friendlyBroadcastError(new Error("Transfer: insufficient funds"))) && /don't need SOL/i.test(friendlyBroadcastError(new Error("insufficient funds for token"))));
check("missing-account error mentions sending USDC", /usdc/i.test(friendlyBroadcastError(new Error("could not find account"))));
check("Anchor 0xbc4 (no USDC account) maps to funding message", /received any USDC/i.test(friendlyBroadcastError(new Error("custom program error: 0xbc4"))));
check("submission-window-closed maps to 'try next contest'", /next one/i.test(friendlyBroadcastError(new Error("SubmissionWindowClosed"))));

// injectAgentId
check("injects agent_id for submit_entry when missing", (injectAgentId("submit_entry", { contest_id: "c", payload: "p" }, "AID").agent_id) === "AID");
check("injects agent_id for get_my_history", injectAgentId("get_my_history", {}, "AID").agent_id === "AID");
check("does NOT override caller-supplied agent_id", injectAgentId("submit_entry", { agent_id: "MINE" }, "AID").agent_id === "MINE");
check("does NOT inject for list_active_contests", injectAgentId("list_active_contests", {}, "AID").agent_id === undefined);
check("no-op when no agent_id configured", injectAgentId("submit_entry", { payload: "p" }, undefined).agent_id === undefined);

// toolTakesAgentId — schema-driven detection
const mkTool = (name: string, props: Record<string, unknown>): Tool =>
  ({ name, description: "", inputSchema: { type: "object", properties: props } } as unknown as Tool);
check("toolTakesAgentId true when schema has agent_id", toolTakesAgentId(mkTool("get_agent_status", { agent_id: { type: "string" } })));
check("toolTakesAgentId false when schema lacks agent_id", !toolTakesAgentId(mkTool("list_active_contests", { track: { type: "string" } })));

// injectAgentId with a runtime-derived set (the real path): covers tools that
// were NOT in the static seed (get_agent_status, get_balance) — the injection
// gap that stranded Path-B agents with "agent_id Required".
const known = new Set(["submit_entry", "get_my_history", "request_email_verification", "get_agent_status", "get_balance", "enroll_entry_vault"]);
check("injects agent_id for get_agent_status via runtime set", injectAgentId("get_agent_status", {}, "AID", known).agent_id === "AID");
check("injects agent_id for get_balance via runtime set", injectAgentId("get_balance", {}, "AID", known).agent_id === "AID");
check("injects agent_id for enroll_entry_vault via runtime set", injectAgentId("enroll_entry_vault", {}, "AID", known).agent_id === "AID");
check("runtime set still does NOT inject for a non-agent tool", injectAgentId("list_active_contests", {}, "AID", known).agent_id === undefined);
check("runtime set still respects caller-supplied agent_id", injectAgentId("get_balance", { agent_id: "MINE" }, "AID", known).agent_id === "MINE");

console.log(`\nSummary: passed ${passed}, failed ${failed}`);
process.exit(failed > 0 ? 1 : 0);
