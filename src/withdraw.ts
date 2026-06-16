/**
 * withdraw.ts — withdraw_to_address: a plain USDC transfer from the agent's
 * local wallet to any Solana address, signed in-process with the same keypair
 * used for entries (autonomous mode only).
 *
 * Unlike submit_entry (where Omniology is the fee payer), a withdrawal is a
 * normal Solana transaction the agent pays for — so it needs a little SOL for
 * the network fee (and ATA rent if the destination has no USDC account yet).
 * Errors are mapped to plain English.
 */
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  getAccount,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
} from "@solana/spl-token";

export const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
export const USDC_DECIMALS = 6;

/** Pure input validation. Returns the parsed destination pubkey or an error. */
export function validateWithdraw(
  amountUsdc: unknown,
  destination: unknown,
): { ok: true; destination: PublicKey } | { ok: false; error: string } {
  if (typeof amountUsdc !== "number" || !Number.isFinite(amountUsdc) || amountUsdc <= 0) {
    return { ok: false, error: "amount_usdc must be a positive number." };
  }
  if (typeof destination !== "string" || destination.trim() === "") {
    return { ok: false, error: "destination_address is required." };
  }
  let pubkey: PublicKey;
  try {
    pubkey = new PublicKey(destination.trim());
  } catch {
    return { ok: false, error: `"${destination}" is not a valid Solana address.` };
  }
  return { ok: true, destination: pubkey };
}

/** Map a withdraw failure to a plain-English message. */
export function friendlyWithdrawError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const logs = (err as { logs?: string[] })?.logs?.join(" ") ?? "";
  const hay = `${raw} ${logs}`.toLowerCase();
  if (
    hay.includes("account not found") ||
    hay.includes("could not find account") ||
    hay.includes("tokenaccountnotfound") ||
    hay.includes("0xbc4") ||
    hay.includes("accountnotinitialized")
  ) {
    return "Your wallet has no USDC to withdraw (no USDC token account yet).";
  }
  if (hay.includes("insufficient") && (hay.includes("lamport") || hay.includes("sol") || hay.includes("rent"))) {
    return "Your wallet needs a little SOL to pay the network fee for a withdrawal (≈ 0.001 SOL, or ≈ 0.003 if the destination has no USDC account yet). Add a tiny bit of SOL and try again.";
  }
  if (hay.includes("insufficient")) {
    return "Your wallet doesn't have enough USDC for that withdrawal amount.";
  }
  if (hay.includes("blockhash") || hay.includes("not confirmed") || hay.includes("expired")) {
    return `The withdrawal was submitted but hasn't confirmed yet: ${raw}. It may still land — check the transaction shortly.`;
  }
  return `Withdrawal failed: ${raw}`;
}

export interface WithdrawResult {
  signature: string;
  amount_usdc: number;
  destination: string;
}

/** Build, sign, and broadcast the USDC transfer. Throws on failure (caller maps). */
export async function withdrawToAddress(
  connection: Connection,
  keypair: Keypair,
  destination: PublicKey,
  amountUsdc: number,
): Promise<WithdrawResult> {
  const sourceAta = await getAssociatedTokenAddress(USDC_MINT, keypair.publicKey, false);
  const destAta = await getAssociatedTokenAddress(USDC_MINT, destination, false);

  // Confirm the source has enough USDC (clearer than a raw on-chain failure).
  const srcAcct = await getAccount(connection, sourceAta).catch(() => null);
  if (!srcAcct) throw new Error("token account not found"); // → friendly "no USDC" message
  const amountBase = BigInt(Math.round(amountUsdc * 10 ** USDC_DECIMALS));
  if (srcAcct.amount < amountBase) {
    throw new Error(`insufficient USDC: have ${Number(srcAcct.amount) / 10 ** USDC_DECIMALS}, need ${amountUsdc}`);
  }

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: keypair.publicKey, blockhash, lastValidBlockHeight }).add(
    // Idempotent: creates the destination USDC account only if it doesn't exist
    // (agent pays the small rent). No-op when it already exists.
    createAssociatedTokenAccountIdempotentInstruction(keypair.publicKey, destAta, destination, USDC_MINT),
    createTransferCheckedInstruction(sourceAta, USDC_MINT, destAta, keypair.publicKey, amountBase, USDC_DECIMALS),
  );
  tx.sign(keypair);
  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: "confirmed",
    maxRetries: 5,
  });
  const conf = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  if (conf.value.err) throw new Error(`on-chain error: ${JSON.stringify(conf.value.err)}`);

  return { signature, amount_usdc: amountUsdc, destination: destination.toBase58() };
}
