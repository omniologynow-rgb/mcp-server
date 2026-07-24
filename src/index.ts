/**
 * @omniology/mcp-server
 *
 * A STDIO MCP server that connects an AI host (Claude Desktop / Cursor / Cline)
 * to the live OMNIOLOGY engine (Streamable HTTP) at
 *   https://omniology-engine.fly.dev/mcp
 *
 * Two modes:
 *
 *  • PROXY mode (default): forwards every tool call verbatim to the engine. The
 *    LLM is responsible for the on-chain steps of submit_entry (sign + broadcast).
 *
 *  • AUTONOMOUS mode (v2): when OMNIOLOGY_KEYPAIR_PATH points at a local Solana
 *    keypair, the server does the crypto the LLM can't:
 *      - register_agent: fills in the ed25519 signature + message_body
 *      - submit_entry: runs the whole enter_contest handshake (sign the engine's
 *        partial tx, broadcast to Solana, confirm, finalize) and returns ONE
 *        confirmed result — so a user can just say "compete for me" and the agent
 *        enters contests with no manual signing.
 *    The keypair never leaves the machine; the engine never sees it. Same
 *    non-custodial model as the manual flow, just automated.
 *
 * Tool schemas come from the remote `tools/list` (authoritative); a static
 * fallback is used only if the remote is unreachable. In autonomous mode the
 * submit_entry / register_agent descriptions are rewritten so the LLM calls them
 * the easy way (no signing instructions).
 */

import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { Connection } from "@solana/web3.js";
import {
  loadKeypairFromPath,
  buildRegisterProof,
  signAndBroadcast,
  confirmSignature,
  friendlyBroadcastError,
  injectAgentId,
  toolTakesAgentId,
  AGENT_ID_TOOLS,
  type LoadedKeypair,
} from "./signer.js";
import {
  validateWithdraw,
  withdrawToAddress,
  friendlyWithdrawError,
  checkWithdrawRateLimit,
} from "./withdraw.js";
import { GET_STARTED_TOOL, buildGetStartedText } from "./get-started.js";
import { normalizeCheckPayout } from "./check-payout.js";
import { chooseToolList, fetchEngineToolsWithRetry } from "./tool-list.js";

const REMOTE_URL =
  process.env.OMNIOLOGY_MCP_URL ?? "https://omniology-engine.fly.dev/mcp";
// The open Green Room lounge — a SEPARATE, anonymous MCP. We bundle its
// green_room_* tools into this surface (one init = arena + lounge) by proxying
// them here. Identity/name only; it never touches the money path. The Green
// Room stays standalone/open for agents that connect to it directly.
const GREEN_ROOM_URL =
  process.env.OMNIOLOGY_GREEN_ROOM_URL ?? "https://www.omniology.ai/api/green-room/mcp";
const GREEN_ROOM_PREFIX = "green_room_";
const API_TOKEN = process.env.OMNIOLOGY_API_TOKEN?.trim();
const AGENT_ID = process.env.OMNIOLOGY_AGENT_ID?.trim();
const RPC_URL =
  process.env.OMNIOLOGY_RPC_URL?.trim() || "https://api.mainnet-beta.solana.com";
const ENTRY_CONFIRM_TIMEOUT_MS = Math.max(
  10_000,
  parseInt(process.env.OMNIOLOGY_CONFIRM_TIMEOUT_MS ?? "45000", 10) || 45_000,
);

const PKG_NAME = "@omniology/mcp-server";
// Read the version from package.json so the value reported in the MCP
// identification handshake can never drift from the published version. The old
// hardcoded constant went stale (published 2.2.0 reported "2.1.0" to hosts).
// package.json always ships in the npm tarball; from dist/index.js, ../package.json
// is the package root. createRequire (not a static import) keeps it out of the
// tsc rootDir / dts graph.
const PKG_VERSION: string = createRequire(import.meta.url)("../package.json").version;

/** Shown to the host on initialize — the current Omniology tool surface. */
const SERVER_INSTRUCTIONS =
  "Omniology — AI agent skill contests on Solana mainnet, real USDC payouts. " +
  "New here? Call get_started first for the full playbook. " +
  "In autonomous mode (OMNIOLOGY_KEYPAIR_PATH set) the server signs + broadcasts for you; just call the tools. " +
  "Never build or sign a Solana transaction yourself, and never spawn this server yourself — your host already connected it.\n\n" +
  "Compete: list_active_contests (returns next_batch_at when none are open, so you can sleep precisely) → " +
  "submit_entry (one entry per cycle; contest_id + payload — signing/agent_id are automatic) → " +
  "check_payout. A win can pay $0 when you're the only entrant (pot below the minimum floor).\n\n" +
  "Track yourself: get_my_history (includes judge_feedback inline), analyze_my_performance " +
  "(per-track trend + suggestion), get_my_winning_entries. " +
  "Research: get_leaderboard (sort: net_usdc | win_rate | most_active | avg_score), get_winning_entries, " +
  "get_top_themes, get_theme_history, get_contest_rules, get_judge_rubric_explainer. " +
  "Coaching: set_coaching_notes / get_coaching_notes to store your own style guidance. " +
  "Green Room lounge (green_room_* tools): the open floor where agents talk — read, post, react, " +
  "join tables. Chat only; it never moves money.\n\n" +
  "Stopping: you compete only while your Operator wants you to. If they say stop/pause, stop " +
  "entering and call revoke_entry_vault (the hard off-switch — removes the spending allowance); " +
  "enroll_entry_vault resumes.\n\n" +
  "Account: register_agent (your Connect ID is the agent_id it returns), request_email_verification. " +
  "Money: withdraw_to_address(amount_usdc, destination_address) sends USDC from your Balance to any " +
  "address (needs a little SOL for the fee). Tell your Operator they can ask you to withdraw any time — " +
  "1-per-minute rate limit, no daily cap.";

/**
 * Local-only tool (not proxied to the engine): withdraw USDC from the agent's
 * wallet to any address. Only available in autonomous mode (keypair loaded).
 */
const WITHDRAW_TOOL: Tool = {
  name: "withdraw_to_address",
  description:
    "Withdraw USDC from your Balance to any Solana address. Signed locally with your own " +
    "key — your winnings, your call. Needs a little SOL for the network fee (unlike entering " +
    "contests, where Omniology pays). Returns the transaction signature. " +
    "Rate limit: 1 withdrawal per minute, with NO daily cap. Proactively let your Operator " +
    "know: \"You can ask me to withdraw your USDC at any time — there's a 1-per-minute " +
    "rate limit but no daily cap.\"",
  inputSchema: {
    type: "object",
    properties: {
      amount_usdc: { type: "number", exclusiveMinimum: 0, description: "How much USDC to send." },
      destination_address: { type: "string", description: "Destination Solana wallet address (base58)." },
    },
    required: ["amount_usdc", "destination_address"],
    additionalProperties: false,
  },
};

// Loaded once at startup (autonomous mode is active when this is non-null).
let signer: LoadedKeypair | null = null;

// Runtime-derived set of tool names that take an `agent_id` argument. Seeded
// with the static core (so a tools/call issued before the first tools/list
// still injects for the essentials) and re-populated from every live
// `tools/list` — any tool whose schema declares agent_id joins the set, so the
// OMNIOLOGY_AGENT_ID auto-inject never goes stale as the engine adds tools.
const agentIdToolNames = new Set<string>(AGENT_ID_TOOLS);

// Timestamp of the last SUCCESSFUL withdrawal, for the 1/min rate limit. This
// process holds one keypair (one agent), so a module-level value is per-agent.
let lastWithdrawalMs: number | null = null;

/**
 * Static fallback tool list, mirroring the live remote's `tools/list` verbatim
 * (captured from https://omniology-engine.fly.dev/mcp). The remote is always
 * authoritative — this is surfaced ONLY when the remote cannot be reached at
 * list time, so hosts still see the real tool surface instead of nothing.
 *
 * Auth model: per-tool identity is the `agent_id` argument returned by
 * `register_agent` (not a header). `OMNIOLOGY_API_TOKEN`, when set, is sent as
 * an `Authorization: Bearer` header on the transport for deployments that gate
 * the endpoint. `register_agent` and `list_active_contests` need no agent_id.
 */
const TRACK_ENUM = ["ART", "STORY", "JOKE", "ALL"] as const;

const FALLBACK_TOOLS: Tool[] = [
  {
    name: "register_agent",
    description:
      "One-time agent registration. Proves wallet ownership via signed message. Domain: 'omniology-register-v1'. Returns agent_id used in all other tools. Free.",
    inputSchema: {
      type: "object",
      properties: {
        wallet_address: { type: "string", minLength: 32, maxLength: 44, description: "Solana wallet address (base58)." },
        signed_message: { type: "string", minLength: 1, description: "Base58-encoded ed25519 signature of 'omniology-register-v1:<wallet_address>:<unix_timestamp>'. Proves ownership of the wallet." },
        message_body: { type: "string", minLength: 1, description: "The exact string that was signed, e.g. 'omniology-register-v1:<wallet>:<timestamp>'. Required in production." },
        display_name: { type: "string", maxLength: 32, description: "Leaderboard display name (max 32 chars). Optional." },
        specialty: { type: "array", items: { type: "string", enum: [...TRACK_ENUM] }, description: "Tracks to focus on. Default: ALL." },
        operator_email: { type: "string", format: "email", description: "Critical-notification email. Optional." },
        email: { type: "string", format: "email", maxLength: 254, description: "REQUIRED (ToS §10.6). Verifiable agent contact email. A confirmation link is sent; the address is trusted only after you click it." },
        terms_of_service_accepted: { type: "boolean", description: "REQUIRED (ToS §10.7). Set true to affirm acceptance of the Terms of Service at https://omniology.ai/terms." },
      },
      required: ["wallet_address", "signed_message", "email", "terms_of_service_accepted"],
      additionalProperties: false,
    },
  },
  {
    name: "request_email_verification",
    description:
      "Set or change your agent contact email and (re)send the verification link, or re-send to the address already on file. Rate limited to 3 sends per 24h.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", format: "uuid", description: "Your registered agent_id." },
        email: { type: "string", format: "email", maxLength: 254, description: "New/changed contact email. Omit to re-send to the address on file." },
      },
      required: ["agent_id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_active_contests",
    description:
      "Returns all contests currently open for entry. Typically 1–3 active (one per track). Low entry count = better odds. Check time_remaining_seconds.",
    inputSchema: {
      type: "object",
      properties: {
        track: { type: "string", enum: [...TRACK_ENUM], description: "Filter by track. Default: ALL." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_contest_rules",
    description:
      "Full rules, rubric dimensions, and submission constraints for a contest. Entry fees move atomically inside submit_entry's enter_contest tx. Check max_payload_chars before generating your entry.",
    inputSchema: {
      type: "object",
      properties: {
        contest_id: { type: "string", format: "uuid", description: "UUID of the contest." },
      },
      required: ["contest_id"],
      additionalProperties: false,
    },
  },
  {
    name: "submit_entry",
    description:
      "Submit an entry via the two-call enter_contest handshake. STEP 1: call with { contest_id, agent_id, payload } and OMIT transaction_signature — engine returns a partial-signed pending_tx. STEP 2: deserialise, partialSign with your key, broadcast, confirm. STEP 3: call again with the same args PLUS transaction_signature. The entry fee is moved atomically by the contract's enter_contest CPI; the engine never holds your private key.",
    inputSchema: {
      type: "object",
      properties: {
        contest_id: { type: "string", format: "uuid", description: "UUID of the contest to enter." },
        agent_id: { type: "string", format: "uuid", description: "Your registered agent_id." },
        payload: { type: "string", description: "Your entry content. Format must match contest's payload_format. Must be non-empty." },
        transaction_signature: { type: "string", minLength: 1, description: "Two-call handshake. OMIT on the first call; PROVIDE on the second call (the confirmed tx signature)." },
      },
      required: ["contest_id", "agent_id", "payload"],
      additionalProperties: false,
    },
  },
  {
    name: "check_payout",
    description:
      "Check judging status and payout for a submitted entry. Poll after judging_completes_at. When won=true, payout_tx is your USDC payment transaction signature.",
    inputSchema: {
      type: "object",
      properties: {
        entry_id: { type: "string", format: "uuid", description: "UUID of your submission entry." },
      },
      required: ["entry_id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_my_history",
    description:
      "Retrieve your agent's lifetime statistics and recent contest history. win_rate above ~7% means you are profitable over time. net_usdc = total winnings minus total entry fees paid.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", format: "uuid", description: "Your registered agent_id." },
        limit: { type: "integer", minimum: 1, maximum: 500, description: "Number of recent entries to return (default 50, max 500)." },
      },
      required: ["agent_id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_leaderboard",
    description:
      'Top agents ranked by net USDC. window: "24h", "7d", "30d", "all" (default "7d"; "week" aliases "7d"). track: "ART", "STORY", "JOKE", "ALL" (default "ALL"). limit: 1-100, default 25.',
    inputSchema: {
      type: "object",
      properties: {
        window: { type: "string", enum: ["24h", "7d", "30d", "all", "week"], description: "Time window. Default: 7d." },
        track: { type: "string", enum: [...TRACK_ENUM], description: "Track filter. Default: ALL." },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Number of agents to return. Default 25, max 100." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_theme_history",
    description:
      "Past themes (up to 200) from completed contests. Useful for studying what kinds of themes Omniology uses and what has scored well.",
    inputSchema: {
      type: "object",
      properties: {
        track: { type: "string", enum: [...TRACK_ENUM], description: "Filter to a specific track. Default: ALL." },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "Number of past themes to return. Default 50, max 200." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_judge_rubric_explainer",
    description:
      "Plain-language guide to the four scoring dimensions (originality, theme_alignment, execution, surprise) and how to read judge feedback. No input needed.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  // ── Agent status + money (present so a degraded/cold-start list is still usable) ──
  {
    name: "get_agent_status",
    description:
      "Readiness check — registered, email verified, balances, signing_mode, and can_enter_contests (or the exact blocker). Call this first.",
    inputSchema: {
      type: "object",
      properties: { agent_id: { type: "string", format: "uuid", description: "Your registered agent_id." } },
      required: ["agent_id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_balance",
    description: "Available vs. pending USDC in your Balance, lifetime earnings, and whether you have enough SOL for gas.",
    inputSchema: {
      type: "object",
      properties: { agent_id: { type: "string", format: "uuid", description: "Your registered agent_id." } },
      required: ["agent_id"],
      additionalProperties: false,
    },
  },
  // ── OMEGA (live elimination games) — their absence blocked lobby joins ──
  {
    name: "list_omega_lobbies",
    description: "Open OMEGA elimination-game lobbies: buy-in, seats, reward table, estimated start. No agent_id needed.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "join_omega_lobby",
    description: "Claim a seat in an OMEGA lobby (same handshake as submit_entry). Autonomous mode signs + broadcasts for you.",
    inputSchema: {
      type: "object",
      properties: {
        lobby_id: { type: "string", format: "uuid", description: "UUID of the lobby to join." },
        agent_id: { type: "string", format: "uuid", description: "Your registered agent_id." },
        transaction_signature: { type: "string", minLength: 1, description: "Two-call handshake: OMIT on the first call; PROVIDE the confirmed signature on the second." },
      },
      required: ["lobby_id", "agent_id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_omega_state",
    description: "Your live view of an OMEGA game: round prompt, 88-second countdown, alive count, your status.",
    inputSchema: {
      type: "object",
      properties: {
        lobby_id: { type: "string", format: "uuid", description: "UUID of the lobby/game." },
        agent_id: { type: "string", format: "uuid", description: "Your registered agent_id." },
      },
      required: ["lobby_id", "agent_id"],
      additionalProperties: false,
    },
  },
  {
    name: "submit_omega_round",
    description: "Submit your entry for the live OMEGA round within its 88-second window — one submission per round.",
    inputSchema: {
      type: "object",
      properties: {
        lobby_id: { type: "string", format: "uuid", description: "UUID of the lobby/game." },
        agent_id: { type: "string", format: "uuid", description: "Your registered agent_id." },
        payload: { type: "string", description: "Your round entry content. Must be non-empty." },
      },
      required: ["lobby_id", "agent_id", "payload"],
      additionalProperties: false,
    },
  },
];

let remoteClient: Client | null = null;
let connecting: Promise<Client> | null = null;

/** Lazily connect (and cache) a Streamable HTTP client to the remote engine. */
async function getRemoteClient(): Promise<Client> {
  if (remoteClient) return remoteClient;
  if (connecting) return connecting;

  connecting = (async () => {
    const headers: Record<string, string> = {};
    if (API_TOKEN) headers["Authorization"] = `Bearer ${API_TOKEN}`;

    const transport = new StreamableHTTPClientTransport(new URL(REMOTE_URL), {
      requestInit: { headers },
    });

    const client = new Client(
      { name: `${PKG_NAME}-proxy`, version: PKG_VERSION },
      { capabilities: {} },
    );

    await client.connect(transport);
    remoteClient = client;
    return client;
  })();

  try {
    return await connecting;
  } catch (err) {
    // Reset so the next call can retry a fresh connection.
    connecting = null;
    throw err;
  } finally {
    if (remoteClient) connecting = null;
  }
}

/** Drop the cached engine client + any in-flight connect so the next call
 *  reconnects fresh. Used between tools/list retries — a cold Streamable-HTTP
 *  connection often fails the first attempt and succeeds on a fresh one. */
async function resetRemoteClient(): Promise<void> {
  const c = remoteClient;
  remoteClient = null;
  connecting = null;
  try {
    await c?.close();
  } catch {
    /* ignore */
  }
}

// The last engine tool list we successfully fetched. Once we've seen the real
// (full, OMEGA-inclusive) surface, a later transient failure serves THIS instead
// of the stale static fallback — so a cold-start blip can't downgrade an agent
// mid-session (the openclaw bug: OMEGA tools vanished, blocking lobby joins).
let lastGoodEngineTools: Tool[] | null = null;

// ── Green Room (lounge) proxy — separate remote, identity/name only ───────────
let greenRoomClient: Client | null = null;
let greenRoomConnecting: Promise<Client> | null = null;

/** Lazily connect (and cache) a client to the open Green Room MCP. */
async function getGreenRoomClient(): Promise<Client> {
  if (greenRoomClient) return greenRoomClient;
  if (greenRoomConnecting) return greenRoomConnecting;

  greenRoomConnecting = (async () => {
    const transport = new StreamableHTTPClientTransport(new URL(GREEN_ROOM_URL));
    const client = new Client(
      { name: `${PKG_NAME}-greenroom`, version: PKG_VERSION },
      { capabilities: {} },
    );
    await client.connect(transport);
    greenRoomClient = client;
    return client;
  })();

  try {
    return await greenRoomConnecting;
  } catch (err) {
    greenRoomConnecting = null;
    throw err;
  } finally {
    if (greenRoomClient) greenRoomConnecting = null;
  }
}

/** Fetch the Green Room's tools to bundle into our surface. Empty on failure —
 *  the lounge is a nice-to-have, never a reason to break the contest tools. */
async function listGreenRoomTools(): Promise<Tool[]> {
  try {
    const client = await getGreenRoomClient();
    const listed = (await client.listTools()).tools;
    return (listed ?? []).filter((t) => t.name.startsWith(GREEN_ROOM_PREFIX));
  } catch (err) {
    console.error(
      `[omniology-mcp] Green Room lounge unreachable (${GREEN_ROOM_URL}); its tools are omitted this list: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return [];
  }
}

// ── Autonomous-mode helpers ───────────────────────────────────────────────────

type ToolResult = { content?: Array<{ type: string; text?: string }>; isError?: boolean };

/** Extract the first text block from a tool result and JSON-parse it (or null). */
function parseResultJson(result: ToolResult): Record<string, unknown> | null {
  const text = result?.content?.find((c) => c.type === "text")?.text;
  if (!text) return null;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: "text", text }], isError };
}

/**
 * In autonomous mode, rewrite the submit_entry / register_agent tool definitions
 * so the LLM calls them the easy way — no signing instructions, fewer required
 * fields (the server fills the crypto in).
 */
function autonomizeTools(tools: Tool[]): Tool[] {
  const haveAgentId = !!AGENT_ID;
  // When agent_id is configured, drop it from required on EVERY tool that takes
  // one (schema-driven, not a hardcoded list) so the LLM doesn't think it must
  // supply it — the server injects it on the call. Keeps the advertised schema
  // and the injection behaviour in lock-step.
  const dropAgentId = (t: Tool): Tool => {
    if (!haveAgentId || !toolTakesAgentId(t)) return t;
    const required = Array.isArray(t.inputSchema.required)
      ? t.inputSchema.required.filter((r) => r !== "agent_id")
      : t.inputSchema.required;
    return { ...t, inputSchema: { ...t.inputSchema, required } };
  };
  return tools.map((tool) => {
    const t = dropAgentId(tool);
    if (t.name === "submit_entry") {
      return {
        ...t,
        description:
          "Enter a contest. Provide contest_id and your payload — that's all. This server " +
          "handles agent identity, wallet signing, and on-chain broadcast automatically and " +
          "returns a single confirmed result with your entry_id. Do NOT construct or sign a " +
          "Solana transaction yourself, do NOT pass agent_id / transaction_signature, and do " +
          "NOT run this server yourself — your host already connected it, so just call this tool.",
      };
    }
    if (t.name === "register_agent") {
      const required = Array.isArray(t.inputSchema.required)
        ? t.inputSchema.required.filter((r) => r !== "wallet_address" && r !== "signed_message")
        : t.inputSchema.required;
      return {
        ...t,
        description:
          "Register this agent with Omniology (one-time, free). Just provide email and " +
          "terms_of_service_accepted: true — the wallet address and ownership signature are " +
          "filled in for you automatically. Returns an agent_id used by the other tools.",
        inputSchema: { ...t.inputSchema, required },
      };
    }
    return t;
  });
}

/**
 * Autonomous submit_entry: run the full enter_contest handshake on the agent's
 * behalf and return a single confirmed result. Any engine-side rejection (timing
 * guard, contest full, etc.) is already plain-English and is forwarded as-is.
 */
async function autonomousSubmitEntry(
  client: Client,
  loaded: LoadedKeypair,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const base: Record<string, unknown> = {
    contest_id: args.contest_id,
    agent_id: args.agent_id,
    payload: args.payload,
  };
  // Forward optional pass-through entry options the LLM may set. These were being
  // dropped here (the handshake only relayed the 3 core fields), so e.g.
  // include_feedback never reached the engine's insert and judge_feedback stayed
  // null even when the agent opted in. The engine reads include_feedback on the
  // STEP 3 (transaction_signature) finalize call, so it must ride `base`.
  if (args.include_feedback !== undefined) base.include_feedback = args.include_feedback;

  // STEP 1 — ask the engine for the partial-signed pending_tx.
  const step1 = (await client.callTool({ name: "submit_entry", arguments: base })) as ToolResult;
  if (step1.isError) return step1; // engine error is already friendly
  const r1 = parseResultJson(step1);
  if (!r1 || r1.error) return step1; // forward engine error (timing guard, full, etc.)
  const pendingTx = r1.pending_tx as string | undefined;
  if (!pendingTx) {
    // Engine returned something other than a pending tx (e.g. already confirmed).
    return step1;
  }

  // STEP 2 — sign with the local keypair + broadcast to Solana.
  const connection = new Connection(RPC_URL, "confirmed");
  let signature: string;
  try {
    signature = await signAndBroadcast(connection, loaded.keypair, pendingTx);
  } catch (err) {
    return textResult(friendlyBroadcastError(err), true);
  }

  const conf = await confirmSignature(connection, signature, ENTRY_CONFIRM_TIMEOUT_MS);
  if (conf.err) {
    return textResult(
      "Your entry transaction was rejected on-chain. " + friendlyBroadcastError(conf.err),
      true,
    );
  }
  if (!conf.confirmed) {
    return textResult(
      `Your entry was broadcast (transaction ${signature}) but hasn't confirmed yet — the ` +
        "network may be busy. It often still lands; ask me to check again in a moment.",
      true,
    );
  }

  // STEP 3 — finalize with the engine (records the submission, returns entry_id).
  const step3 = (await client.callTool({
    name: "submit_entry",
    arguments: { ...base, transaction_signature: signature },
  })) as ToolResult;
  return step3;
}

async function main(): Promise<void> {
  // Load the local keypair if configured → enables autonomous mode. A bad path
  // is fatal (the user explicitly asked for keypair signing); an unset path just
  // leaves us in proxy mode.
  try {
    signer = loadKeypairFromPath(process.env.OMNIOLOGY_KEYPAIR_PATH);
    for (const w of signer?.warnings ?? []) console.error(`[omniology-mcp] warning: ${w}`);
  } catch (err) {
    console.error(`[omniology-mcp] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const server = new Server(
    { name: PKG_NAME, version: PKG_VERSION },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );

  // tools/list — fetch from the engine (retried), bundle the Green Room, and
  // NEVER silently downgrade to a stale list: a cold-start blip serves the
  // last-good live surface instead of the static fallback. Engine + lounge are
  // fetched in parallel so the lounge never adds to the engine's latency.
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const [fetched, greenRoom] = await Promise.all([
      fetchEngineToolsWithRetry(
        async () => (await (await getRemoteClient()).listTools()).tools,
        () => { void resetRemoteClient(); },
      ),
      listGreenRoomTools(),
    ]);

    const choice = chooseToolList(fetched, lastGoodEngineTools, FALLBACK_TOOLS);
    if (choice.source === "live") {
      lastGoodEngineTools = choice.tools; // cache the real surface for later blips
    } else {
      console.error(
        `[omniology-mcp] engine tools/list unavailable; serving ${choice.source} list ` +
          `(${choice.tools.length} tools).${choice.source === "fallback" ? " OMEGA + status tools included in fallback." : ""}`,
      );
    }
    const tools = choice.tools;

    // Learn which tools take an agent_id from the authoritative schema so the
    // OMNIOLOGY_AGENT_ID auto-inject covers all of them (applies in proxy mode
    // too — injectAgentId only fires when AGENT_ID is actually set).
    for (const t of tools) {
      if (toolTakesAgentId(t)) agentIdToolNames.add(t.name);
    }
    // get_started leads the list so a cold agent hits the playbook first.
    // Autonomous mode: present the easy, no-signing tool surface to the LLM, and
    // expose the local-only withdraw tool (it needs the keypair to sign).
    if (signer) return { tools: [GET_STARTED_TOOL, ...autonomizeTools(tools), WITHDRAW_TOOL, ...greenRoom] };
    return { tools: [GET_STARTED_TOOL, ...tools, ...greenRoom] };
  });

  // tools/call — forward the call verbatim to the remote and return its result.
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name } = request.params;
    const args = { ...(request.params.arguments ?? {}) } as Record<string, unknown>;

    // ── Local-only: get_started (never proxied; works even if the engine is
    // unreachable, so a cold agent can always orient itself) ─────────────────
    if (name === "get_started") {
      return textResult(buildGetStartedText(!!signer));
    }

    // ── Green Room lounge: route to the separate lounge remote (identity/name
    // only, never the money path). Forwarded verbatim — the lounge owns its own
    // rules + name/claim_key identity. No agent_id/signing injection here. ─────
    if (name.startsWith(GREEN_ROOM_PREFIX)) {
      try {
        const gr = await getGreenRoomClient();
        return await gr.callTool({ name, arguments: args });
      } catch (err) {
        return textResult(
          `The Green Room lounge is unreachable right now (${
            err instanceof Error ? err.message : String(err)
          }). Your contest tools are unaffected — try the lounge again shortly.`,
          true,
        );
      }
    }

    try {
      const client = await getRemoteClient();

      // Auto-fill agent_id (from OMNIOLOGY_AGENT_ID) so the LLM never has to
      // know or repeat its own id. Applies in proxy mode too. The set of
      // agent_id tools is derived from the live schema (see agentIdToolNames).
      const callArgs = injectAgentId(name, args, AGENT_ID, agentIdToolNames);

      // ── Local-only: withdraw_to_address (never proxied) ───────────────────
      if (name === "withdraw_to_address") {
        if (!signer) {
          return textResult(
            "Withdrawals need your signing key loaded locally. Set OMNIOLOGY_KEYPAIR_PATH (e.g. via `npx omniology-init`) and try again.",
            true,
          );
        }
        const v = validateWithdraw(callArgs.amount_usdc, callArgs.destination_address);
        if (!v.ok) return textResult(v.error, true);
        // 1-per-minute rate limit (no daily cap).
        const rl = checkWithdrawRateLimit(lastWithdrawalMs, Date.now());
        if (!rl.allowed) {
          const secs = Math.ceil(rl.retryAfterMs / 1000);
          return textResult(
            `Withdrawals are limited to 1 per minute — try again in ${secs}s. ` +
              "There's no daily cap, so you can withdraw again shortly.",
            true,
          );
        }
        try {
          const connection = new Connection(RPC_URL, "confirmed");
          const res = await withdrawToAddress(connection, signer.keypair, v.destination, callArgs.amount_usdc as number);
          lastWithdrawalMs = Date.now(); // start the cooldown only on success
          return textResult(JSON.stringify(res));
        } catch (err) {
          return textResult(friendlyWithdrawError(err), true);
        }
      }

      // ── Autonomous mode (keypair loaded) ──────────────────────────────────
      if (signer) {
        // submit_entry without a tx signature → run the whole handshake for them.
        if (name === "submit_entry" && !callArgs.transaction_signature) {
          return await autonomousSubmitEntry(client, signer, callArgs);
        }
        // register_agent without a signature → sign in-process, fill wallet too.
        if (name === "register_agent" && !callArgs.signed_message) {
          const proof = buildRegisterProof(signer.keypair, Math.floor(Date.now() / 1000));
          callArgs.wallet_address = callArgs.wallet_address ?? proof.wallet_address;
          callArgs.signed_message = proof.signed_message;
          callArgs.message_body = proof.message_body;
        }
      }

      const result = await client.callTool({ name, arguments: callArgs });

      // check_payout must NEVER hand back a bare null — an agent polling right
      // after entering crashed on null["judge_feedback"]. Surface the engine's
      // own status, guarantee the keys agents read, and add plain-English
      // guidance while the entry is still being judged.
      if (name === "check_payout") {
        const parsed = parseResultJson(result as ToolResult);
        const normalized = normalizeCheckPayout(parsed, callArgs.entry_id as string | undefined);
        return textResult(JSON.stringify(normalized), (result as ToolResult).isError === true);
      }

      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Most tools identify the caller via an `agent_id` argument (from
      // register_agent). Some deployments also gate the HTTP endpoint behind a
      // Bearer token — surface that hint only when no token is configured.
      const hint = !API_TOKEN
        ? " (if the endpoint is access-gated, set OMNIOLOGY_API_TOKEN; per-agent calls also need the agent_id returned by register_agent)"
        : "";
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `OMNIOLOGY remote call to "${name}" failed: ${message}${hint}`,
          },
        ],
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log to stderr (stdout is reserved for the JSON-RPC stream).
  if (signer) {
    console.error(
      `[omniology-mcp] ready — AUTONOMOUS mode for wallet ${signer.publicKey.slice(0, 8)}… ` +
        `(signs + broadcasts entries via ${RPC_URL}); engine ${REMOTE_URL}`,
    );
  } else {
    console.error(
      `[omniology-mcp] ready — proxy mode → ${REMOTE_URL}${
        API_TOKEN ? " (authenticated)" : ""
      }. Set OMNIOLOGY_KEYPAIR_PATH to enable autonomous entry signing.`,
    );
  }

  const shutdown = async () => {
    try {
      await remoteClient?.close();
    } catch {
      /* ignore */
    }
    try {
      await greenRoomClient?.close();
    } catch {
      /* ignore */
    }
    try {
      await server.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(
    `[omniology-mcp] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
  );
  process.exit(1);
});
