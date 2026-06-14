/**
 * signer.ts — optional local-keypair signing for @omniology/mcp-server.
 *
 * When OMNIOLOGY_KEYPAIR_PATH is set, the server loads the user's Solana
 * keypair and can complete the on-chain steps an LLM host cannot do itself:
 *
 *   • register_agent  — fill in the ed25519 signature + message_body
 *   • submit_entry    — run the full enter_contest handshake (sign the engine's
 *                       partial tx, broadcast, confirm, finalize) and return a
 *                       single confirmed result
 *
 * The keypair NEVER leaves the user's machine. The engine is the fee payer, so
 * the user needs USDC to enter but effectively no SOL. This is the same
 * non-custodial model as the manual flow — just automated so a non-technical
 * user can say "compete for me" and walk away.
 */

import { readFileSync, statSync } from "node:fs";
import { Connection, Keypair, Transaction, type Commitment } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";

export const REGISTER_DOMAIN = "omniology-register-v1";

/** Result of loading a keypair: the key plus any non-fatal warnings to log. */
export interface LoadedKeypair {
  keypair: Keypair;
  publicKey: string;
  warnings: string[];
}

/**
 * Load a Solana keypair from a solana-keygen-style JSON file (a 64-byte secret
 * key as a JSON array). Returns null if no path is configured. Throws a
 * human-readable error if the path is set but the file is missing/invalid.
 */
export function loadKeypairFromPath(path: string | undefined): LoadedKeypair | null {
  if (!path || path.trim() === "") return null;
  const p = path.trim();

  let raw: string;
  try {
    raw = readFileSync(p, "utf8");
  } catch {
    throw new Error(
      `Could not read your wallet file at ${p}. Make sure the path is correct (set OMNIOLOGY_KEYPAIR_PATH), or run \`npx @omniology/init\` to create one.`,
    );
  }

  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    throw new Error(
      `Your wallet file at ${p} is not valid JSON. It should be a JSON array of 64 numbers (the format \`solana-keygen\` and \`npx @omniology/init\` produce).`,
    );
  }

  if (!Array.isArray(arr) || (arr.length !== 64 && arr.length !== 32)) {
    throw new Error(
      `Your wallet file at ${p} does not look like a Solana keypair (expected a JSON array of 64 numbers). Re-create it with \`npx @omniology/init\`.`,
    );
  }

  let keypair: Keypair;
  try {
    const bytes = Uint8Array.from(arr as number[]);
    keypair = bytes.length === 64 ? Keypair.fromSecretKey(bytes) : Keypair.fromSeed(bytes);
  } catch {
    throw new Error(
      `Your wallet file at ${p} could not be parsed as a Solana keypair. Re-create it with \`npx @omniology/init\`.`,
    );
  }

  const warnings: string[] = [];
  // Best-effort permissions check (POSIX only). World/group readable secret = warn.
  if (process.platform !== "win32") {
    try {
      const mode = statSync(p).mode & 0o077;
      if (mode !== 0) {
        warnings.push(
          `Your wallet file ${p} is readable by other users. Tighten it with: chmod 600 ${p}`,
        );
      }
    } catch {
      /* non-fatal */
    }
  }

  return { keypair, publicKey: keypair.publicKey.toBase58(), warnings };
}

/**
 * Produce the register_agent proof for a keypair: a raw ed25519 signature over
 * the literal UTF-8 message "omniology-register-v1:<wallet>:<unix_seconds>".
 */
export function buildRegisterProof(keypair: Keypair, nowSeconds: number): {
  wallet_address: string;
  signed_message: string;
  message_body: string;
} {
  const wallet = keypair.publicKey.toBase58();
  const message_body = `${REGISTER_DOMAIN}:${wallet}:${nowSeconds}`;
  const seed = keypair.secretKey.slice(0, 32);
  const sig = ed25519.sign(new TextEncoder().encode(message_body), seed);
  return { wallet_address: wallet, signed_message: bs58.encode(sig), message_body };
}

/** Turn a raw broadcast error into a plain-English, actionable message. */
export function friendlyBroadcastError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const logs = (err as { logs?: string[] })?.logs?.join(" ") ?? "";
  const hay = `${raw} ${logs}`.toLowerCase();

  // No USDC token account yet. enter_contest's `agent_usdc_ata` constraint fails
  // before the body runs → Anchor error 3012 (0xbc4, AccountNotInitialized), or a
  // plain "account not found" depending on the path.
  if (
    hay.includes("0xbc4") ||
    hay.includes("accountnotinitialized") ||
    hay.includes("could not find account") ||
    hay.includes("accountnotfound") ||
    hay.includes("invalidaccount") ||
    hay.includes("account does not exist")
  ) {
    return "Your agent wallet hasn't received any USDC yet, so it can't enter contests. Send a small amount of USDC to the wallet (you don't need SOL — Omniology covers the network fee), then ask me to try again.";
  }
  // Has a USDC account but not enough for the entry fee. The contract's
  // InsufficientUsdcBalance check, or an SPL transfer shortfall.
  if (
    hay.includes("insufficientusdcbalance") ||
    (hay.includes("insufficient") && (hay.includes("usdc") || hay.includes("token") || hay.includes("funds")))
  ) {
    return "Your agent wallet doesn't have enough USDC to cover this contest's entry fee. Add a little USDC to the wallet and ask me to try again — you don't need SOL, Omniology covers the network fee.";
  }
  if (hay.includes("submissionwindowclosed") || hay.includes("contestnotopen")) {
    return "That contest closed before the entry landed. Ask me to try the next one — a fresh batch opens about every 88 seconds.";
  }
  if (hay.includes("blockhash") || hay.includes("expired")) {
    return "The entry took too long to broadcast and the network window expired. This is usually transient — ask me to try the next contest.";
  }
  if (hay.includes("contestfull") || hay.includes("contest at capacity")) {
    return "That contest filled up before the entry landed. Ask me to try the next one — a fresh batch opens about every 88 seconds.";
  }
  return `The entry couldn't be broadcast to Solana right now: ${raw}. This is usually transient — ask me to try again or move to the next contest.`;
}

/** Poll until a signature reaches the target commitment, or time out. */
export async function confirmSignature(
  connection: Connection,
  signature: string,
  timeoutMs: number,
  commitment: Commitment = "confirmed",
): Promise<{ confirmed: boolean; err: unknown | null }> {
  const deadline = Date.now() + timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (Date.now() < deadline) {
    const { value } = await connection.getSignatureStatuses([signature]);
    const st = value[0];
    if (st) {
      if (st.err) return { confirmed: false, err: st.err };
      if (
        st.confirmationStatus === commitment ||
        st.confirmationStatus === "finalized" ||
        (commitment === "confirmed" && st.confirmationStatus === "confirmed")
      ) {
        return { confirmed: true, err: null };
      }
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return { confirmed: false, err: null };
}

/** Sign (partial) the engine's pending_tx with the keypair and broadcast it. */
export async function signAndBroadcast(
  connection: Connection,
  keypair: Keypair,
  pendingTxBase64: string,
): Promise<string> {
  const tx = Transaction.from(Buffer.from(pendingTxBase64, "base64"));
  // The engine already partial-signed as fee payer and baked in the priority
  // fee + compute budget. We add ONLY the agent's signature — never modify the
  // message, or the engine signature would be invalidated.
  tx.partialSign(keypair);
  return connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: "confirmed",
    maxRetries: 5,
  });
}
