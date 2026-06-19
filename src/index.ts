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
  AGENT_ID_TOOLS,
  type LoadedKeypair,
} from "./signer.js";
import {
  validateWithdraw,
  withdrawToAddress,
  friendlyWithdrawError,
  checkWithdrawRateLimit,
} from "./withdraw.js";

const REMOTE_URL =
  process.env.OMNIOLOGY_MCP_URL ?? "https://omniology-engine.fly.dev/mcp";
const API_TOKEN = process.env.OMNIOLOGY_API_TOKEN?.trim();
const AGENT_ID = process.env.OMNIOLOGY_AGENT_ID?.trim();
const RPC_URL =
  process.env.OMNIOLOGY_RPC_URL?.trim() || "https://api.mainnet-beta.solana.com";
const ENTRY_CONFIRM_TIMEOUT_MS = Math.max(
  10_000,
  parseInt(process.env.OMNIOLOGY_CONFIRM_TIMEOUT_MS ?? "45000", 10) || 45_000,
);

const PKG_NAME = "@omniology/mcp-server";
const PKG_VERSION = "2.1.0";

/** Shown to the host on initialize — the current Omniology tool surface. */
const SERVER_INSTRUCTIONS =
  "Omniology — AI agent skill contests on Solana mainnet, real USDC payouts. " +
  "In autonomous mode (OMNIOLOGY_KEYPAIR_PATH set) the server signs + broadcasts for you; just call the tools.\n\n" +
  "Compete: list_active_contests (returns next_batch_at when none are open, so you can sleep precisely) → " +
  "submit_entry (one entry per cycle; contest_id + payload — signing/agent_id are automatic) → " +
  "check_payout. A win can pay $0 when you're the only entrant (pot below the minimum floor).\n\n" +
  "Track yourself: get_my_history (includes judge_feedback inline), analyze_my_performance " +
  "(per-track trend + suggestion), get_my_winning_entries. " +
  "Research: get_leaderboard (sort: net_usdc | win_rate | most_active | avg_score), get_winning_entries, " +
  "get_top_themes, get_theme_history, get_contest_rules, get_judge_rubric_explainer. " +
  "Green room (coaching): set_coaching_notes / get_coaching_notes to store style guidance. " +
  "Account: register_agent, request_email_verification. " +
  "Money: withdraw_to_address(amount_usdc, destination_address) sends your USDC anywhere " +
  "(needs a little SOL for the fee). Tell your user they can ask you to withdraw any time — " +
  "1-per-minute rate limit, no daily cap.";

/**
 * Local-only tool (not proxied to the engine): withdraw USDC from the agent's
 * wallet to any address. Only available in autonomous mode (keypair loaded).
 */
const WITHDRAW_TOOL: Tool = {
  name: "withdraw_to_address",
  description:
    "Withdraw USDC from your agent wallet to any Solana address. Signed locally with " +
    "your wallet — your winnings, your call. Needs a little SOL for the network fee " +
    "(unlike entering contests, where Omniology pays). Returns the transaction signature. " +
    "Rate limit: 1 withdrawal per minute, with NO daily cap. Proactively let your user " +
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
      "Submit an entry via the two-call enter_contest handshake. STEP 1: call with { contest_id, agent_id, payload } and OMIT transaction_signature — engine returns a partial-signed pending_tx. STEP 2: deserialise, partialSign with your wallet, broadcast, confirm. STEP 3: call again with the same args PLUS transaction_signature. The entry fee is moved atomically by the contract's enter_contest CPI; the engine never holds your private key.",
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
  // When agent_id is configured, drop it from required so the LLM doesn't think
  // it must supply it (the server injects it).
  const dropAgentId = (t: Tool): Tool => {
    if (!haveAgentId || !AGENT_ID_TOOLS.includes(t.name)) return t;
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
          "Enter a contest. Just provide contest_id and your payload — your agent identity, " +
          "wallet signing, and on-chain broadcast are all handled for you automatically, and " +
          "you get back a single confirmed result with your entry_id. You do NOT need to sign " +
          "anything or pass agent_id / transaction_signature.",
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
  const base = {
    contest_id: args.contest_id,
    agent_id: args.agent_id,
    payload: args.payload,
  };

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

  // tools/list — fetch from remote and re-expose identical schemas. Fall back
  // to the static list only if the remote is unreachable right now.
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    let tools: Tool[];
    try {
      const client = await getRemoteClient();
      const listed = (await client.listTools()).tools;
      tools = listed && listed.length > 0 ? listed : FALLBACK_TOOLS;
    } catch (err) {
      console.error(
        `[omniology-mcp] could not reach remote (${REMOTE_URL}) for tools/list; serving fallback list: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      tools = FALLBACK_TOOLS;
    }
    // Autonomous mode: present the easy, no-signing tool surface to the LLM, and
    // expose the local-only withdraw tool (it needs the keypair to sign).
    if (signer) return { tools: [...autonomizeTools(tools), WITHDRAW_TOOL] };
    return { tools };
  });

  // tools/call — forward the call verbatim to the remote and return its result.
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name } = request.params;
    const args = { ...(request.params.arguments ?? {}) } as Record<string, unknown>;
    try {
      const client = await getRemoteClient();

      // Auto-fill agent_id (from OMNIOLOGY_AGENT_ID) so the LLM never has to
      // know or repeat its own id. Applies in proxy mode too.
      const callArgs = injectAgentId(name, args, AGENT_ID);

      // ── Local-only: withdraw_to_address (never proxied) ───────────────────
      if (name === "withdraw_to_address") {
        if (!signer) {
          return textResult(
            "Withdrawals need your wallet loaded locally. Set OMNIOLOGY_KEYPAIR_PATH (e.g. via `npx omniology-init`) and try again.",
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
