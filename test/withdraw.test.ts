/** Unit tests for withdraw validation + error mapping (pure). Run: npm run test:withdraw */
import { Keypair } from "@solana/web3.js";
import { validateWithdraw, friendlyWithdrawError, USDC_MINT, checkWithdrawRateLimit, WITHDRAW_MIN_INTERVAL_MS } from "../src/withdraw.js";

let passed = 0, failed = 0;
const check = (n: string, c: boolean, d = "") => {
  if (c) { passed++; console.log(`  ✓ ${n}`); }
  else { failed++; console.log(`  ✗ ${n}${d ? " — " + d : ""}`); }
};

console.log("withdraw.ts unit tests");

const validAddr = Keypair.generate().publicKey.toBase58();

check("valid amount + address → ok", validateWithdraw(1.5, validAddr).ok === true);
check("amount 0 → error", validateWithdraw(0, validAddr).ok === false);
check("negative amount → error", validateWithdraw(-1, validAddr).ok === false);
check("NaN amount → error", validateWithdraw(NaN, validAddr).ok === false);
check("non-number amount → error", validateWithdraw("5" as unknown as number, validAddr).ok === false);
check("empty address → error", validateWithdraw(1, "").ok === false);
check("garbage address → error", validateWithdraw(1, "not-a-real-address").ok === false);
// Too-short / wrong-charset strings aren't valid base58 pubkeys → rejected.
check("too-short address → error", validateWithdraw(1, "abc").ok === false);
check("non-base58 chars → error", validateWithdraw(1, "0OIl_not_base58_0OIl_not_base58_0").ok === false);
void USDC_MINT;

const r = validateWithdraw(2.25, validAddr);
check("ok result carries parsed destination", r.ok === true && r.destination.toBase58() === validAddr);

check("no-USDC-account error is friendly", /no USDC/i.test(friendlyWithdrawError(new Error("token account not found"))));
check("insufficient-SOL error mentions network fee", /SOL/i.test(friendlyWithdrawError(new Error("insufficient lamports for rent"))) && /network fee/i.test(friendlyWithdrawError(new Error("insufficient lamports"))));
check("insufficient-USDC error is friendly", /enough USDC/i.test(friendlyWithdrawError(new Error("insufficient USDC: have 0.5, need 2"))));

// ── rate limit (1/min, no daily cap) ──────────────────────────────────────────
const T = 1_000_000_000_000;
check("first withdrawal (no prior) → allowed", checkWithdrawRateLimit(null, T).allowed === true);
check("immediately after a withdrawal → blocked", checkWithdrawRateLimit(T, T + 1).allowed === false);
check("blocked result reports retryAfterMs", checkWithdrawRateLimit(T, T + 1).retryAfterMs === WITHDRAW_MIN_INTERVAL_MS - 1);
check("just under a minute later → still blocked", checkWithdrawRateLimit(T, T + WITHDRAW_MIN_INTERVAL_MS - 1).allowed === false);
check("exactly a minute later → allowed", checkWithdrawRateLimit(T, T + WITHDRAW_MIN_INTERVAL_MS).allowed === true);
check("well past a minute → allowed (no daily cap)", checkWithdrawRateLimit(T, T + 5 * WITHDRAW_MIN_INTERVAL_MS).allowed === true);

console.log(`\nSummary: passed ${passed}, failed ${failed}`);
process.exit(failed > 0 ? 1 : 0);
