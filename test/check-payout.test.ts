/**
 * Unit tests for check-payout.ts (pure). Run via npm run test:unit.
 *
 * The bug this guards: an agent polled check_payout right after entering, got a
 * null payload, and crashed on null["judge_feedback"].
 */
import { normalizeCheckPayout, PENDING_MESSAGE } from "../src/check-payout.js";

let passed = 0, failed = 0;
const check = (n: string, c: boolean, d = "") => {
  if (c) { passed++; console.log(`  ✓ ${n}`); }
  else { failed++; console.log(`  ✗ ${n}${d ? " — " + d : ""}`); }
};

console.log("check-payout.ts unit tests");

// ── Never a bare null ────────────────────────────────────────────────────────
for (const [label, input] of [["null", null], ["undefined", undefined], ["string", "nope" as unknown], ["array", [] as unknown]] as const) {
  const r = normalizeCheckPayout(input as unknown, "e-1");
  check(`${label} → object, never null`, r !== null && typeof r === "object");
  check(`${label} → judge_feedback key exists (no crash on access)`, "judge_feedback" in r && r["judge_feedback"] === null);
  check(`${label} → pending status + guidance`, r["status"] === "judging" && r["message"] === PENDING_MESSAGE);
  check(`${label} → carries entry_id`, r["entry_id"] === "e-1");
  check(`${label} → won is false, not undefined`, r["won"] === false);
}

// ── Engine status is surfaced, not invented ──────────────────────────────────
const judged = normalizeCheckPayout({ entry_id: "e-2", status: "judged", won: true, score: 8.4, judge_feedback: "great", payout_tx: null }, "e-2");
check("judged: engine status preserved", judged["status"] === "judged");
check("judged: no pending message attached", judged["message"] === undefined);
check("judged: real feedback preserved", judged["judge_feedback"] === "great");
check("judged: won preserved", judged["won"] === true);

const paid = normalizeCheckPayout({ status: "paid", won: true, payout_tx: "sig123", payout_amount_usdc: 0.42 });
check("paid: terminal status preserved", paid["status"] === "paid" && paid["payout_tx"] === "sig123");
check("paid: no pending message", paid["message"] === undefined);

// ── Pending statuses get the guidance ────────────────────────────────────────
for (const s of ["submitted", "judging"]) {
  const r = normalizeCheckPayout({ entry_id: "e-3", status: s, judge_feedback: null, won: false });
  check(`${s}: guidance message added`, r["message"] === PENDING_MESSAGE);
  check(`${s}: status untouched`, r["status"] === s);
}

// A pre-existing message from the engine is not clobbered.
const withMsg = normalizeCheckPayout({ status: "judging", message: "engine says hi" });
check("existing message preserved", withMsg["message"] === "engine says hi");

// ── Missing status is treated as pending (still no crash) ────────────────────
const noStatus = normalizeCheckPayout({ entry_id: "e-4" }, "e-4");
check("missing status → judging + guidance", noStatus["status"] === "judging" && noStatus["message"] === PENDING_MESSAGE);
check("missing status → judge_feedback filled", noStatus["judge_feedback"] === null);

// ── Engine error envelopes pass through untouched ────────────────────────────
const err = normalizeCheckPayout({ error: true, code: "ENTRY_NOT_FOUND", message: "Entry x not found." });
check("error envelope passes through", err["error"] === true && err["code"] === "ENTRY_NOT_FOUND");
check("error envelope keeps its own message", err["message"] === "Entry x not found.");
check("error envelope is not given a fake status", err["status"] === undefined);

console.log(`\nSummary: passed ${passed}, failed ${failed}`);
process.exit(failed > 0 ? 1 : 0);
