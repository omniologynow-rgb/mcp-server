/**
 * @omniology/mcp-server
 *
 * A thin STDIO MCP server that proxies every request to the live remote
 * OMNIOLOGY MCP server (Streamable HTTP transport) at
 *   https://omniology-engine.fly.dev/mcp
 *
 * Why this exists: Claude Desktop / Cursor / Cline can launch a local STDIO
 * command via `npx` with zero HTTP-transport configuration. This wrapper does
 * that wiring for the user — it speaks STDIO to the host on one side and
 * Streamable HTTP to the remote OMNIOLOGY engine on the other, forwarding the
 * `OMNIOLOGY_API_TOKEN` as an `Authorization: Bearer` header on every outbound
 * request.
 *
 * Design: tool schemas are NOT hardcoded as the source of truth. On first use
 * we connect to the remote and call `tools/list`, cache the result, and
 * re-expose the identical schemas locally. Tool calls are forwarded verbatim.
 * A static fallback list is used only if the remote is unreachable at the
 * moment the host asks for the tool list, so the server still advertises its
 * surface area instead of returning empty.
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

const REMOTE_URL =
  process.env.OMNIOLOGY_MCP_URL ?? "https://omniology-engine.fly.dev/mcp";
const API_TOKEN = process.env.OMNIOLOGY_API_TOKEN?.trim();

const PKG_NAME = "@omniology/mcp-server";
const PKG_VERSION = "1.0.0";

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

async function main(): Promise<void> {
  const server = new Server(
    { name: PKG_NAME, version: PKG_VERSION },
    { capabilities: { tools: {} } },
  );

  // tools/list — fetch from remote and re-expose identical schemas. Fall back
  // to the static list only if the remote is unreachable right now.
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      const client = await getRemoteClient();
      const { tools } = await client.listTools();
      if (tools && tools.length > 0) return { tools };
      return { tools: FALLBACK_TOOLS };
    } catch (err) {
      console.error(
        `[omniology-mcp] could not reach remote (${REMOTE_URL}) for tools/list; serving fallback list: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return { tools: FALLBACK_TOOLS };
    }
  });

  // tools/call — forward the call verbatim to the remote and return its result.
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const client = await getRemoteClient();
      const result = await client.callTool({
        name,
        arguments: args ?? {},
      });
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
  console.error(
    `[omniology-mcp] ready — proxying to ${REMOTE_URL}${
      API_TOKEN ? " (authenticated)" : " (no token; only public tools will work)"
    }`,
  );

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
