/**
 * check-payout.ts — never hand an agent a bare `null` from check_payout.
 *
 * A live agent polled check_payout right after entering, got a null/empty
 * payload back, and crashed on `null["judge_feedback"]`. The engine itself
 * already returns a rich object with a coarse `status`
 * (submitted | judging | judged | paid | below_floor) and `judge_feedback: null`
 * while judging — so the job here is:
 *
 *   1. Surface the engine's own status (never invent one when it's present).
 *   2. Guarantee the keys agents index on always exist (judge_feedback, won,
 *      status), so property access can't throw.
 *   3. Add a plain-English `message` while the entry is still pending, telling
 *      the agent what to do instead of hot-polling.
 *   4. Only synthesize a pending state when the payload is genuinely null /
 *      unparseable / not an object.
 *
 * Engine error envelopes ({error:true,...}, e.g. ENTRY_NOT_FOUND) pass through
 * untouched — a real error should stay a real error, just never a bare null.
 */

/** What to tell an agent whose entry hasn't been judged yet. */
export const PENDING_MESSAGE =
  "Entry recorded — still being judged. Judging runs until the contest window closes, so " +
  "there is nothing to do right now. Use get_my_history to confirm the result (it's always " +
  "complete once judging finishes), or wait time_remaining + ~10s before checking again.";

/** Statuses that mean "not judged yet" — safe to attach the pending guidance. */
const PENDING_STATUSES = new Set(["submitted", "judging"]);

/**
 * Normalize a parsed check_payout payload so it is ALWAYS a usable object.
 * `parsed` is whatever came back from the engine (possibly null/undefined).
 */
export function normalizeCheckPayout(
  parsed: unknown,
  entryId?: string,
): Record<string, unknown> {
  // Genuinely nothing usable → synthesize the graceful pending state.
  if (parsed === null || parsed === undefined || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      entry_id: entryId ?? null,
      status: "judging",
      won: false,
      score: null,
      rank: null,
      payout_amount_usdc: 0,
      payout_tx: null,
      judge_feedback: null,
      message: PENDING_MESSAGE,
    };
  }

  const o = { ...(parsed as Record<string, unknown>) };

  // A real engine error stays a real error (but is never null).
  if (o["error"] === true) return o;

  // Guarantee the fields agents commonly read, so property access can't throw.
  if (o["status"] == null) o["status"] = "judging";
  if (!("judge_feedback" in o)) o["judge_feedback"] = null;
  if (!("won" in o)) o["won"] = false;
  if (!("score" in o)) o["score"] = null;
  if (!("payout_tx" in o)) o["payout_tx"] = null;
  if (entryId && o["entry_id"] == null) o["entry_id"] = entryId;

  // Still pending → say so in plain English instead of inviting a hot poll.
  if (typeof o["status"] === "string" && PENDING_STATUSES.has(o["status"])) {
    if (!o["message"]) o["message"] = PENDING_MESSAGE;
  }

  return o;
}
