/**
 * Unit tests for tool-list.ts (pure). Run via npm run test:unit.
 *
 * Guards the openclaw bug: when the engine tools/list momentarily fails, the
 * server must NOT downgrade to a stale static list that's missing the OMEGA
 * tools — it should retry, and prefer the last-good live list over the fallback.
 */
import { chooseToolList, fetchEngineToolsWithRetry } from "../src/tool-list.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

let passed = 0, failed = 0;
const check = (n: string, c: boolean, d = "") => {
  if (c) { passed++; console.log(`  ✓ ${n}`); }
  else { failed++; console.log(`  ✗ ${n}${d ? " — " + d : ""}`); }
};

console.log("tool-list.ts unit tests");

const mk = (names: string[]): Tool[] => names.map((name) => ({ name, description: "", inputSchema: { type: "object", properties: {} } } as unknown as Tool));
const LIVE = mk(["submit_entry", "join_omega_lobby", "get_agent_status"]);
const CACHE = mk(["submit_entry", "join_omega_lobby"]);
const FALLBACK = mk(["submit_entry", "list_active_contests"]); // no OMEGA

// ── chooseToolList precedence ────────────────────────────────────────────────
check("live wins when present", chooseToolList(LIVE, CACHE, FALLBACK).source === "live");
check("cache wins over fallback when no live", chooseToolList(null, CACHE, FALLBACK).source === "cache");
check("cache preserves OMEGA (not the stale fallback)", chooseToolList(null, CACHE, FALLBACK).tools.some((t) => t.name === "join_omega_lobby"));
check("fallback only as last resort", chooseToolList(null, null, FALLBACK).source === "fallback");
check("empty live array is treated as no-live", chooseToolList([], CACHE, FALLBACK).source === "cache");
check("empty cache falls through to fallback", chooseToolList(null, [], FALLBACK).source === "fallback");

// ── fetchEngineToolsWithRetry ────────────────────────────────────────────────
const noSleep = async () => {};

// Succeeds on the 2nd attempt (the cold-connection case) → returns live, not null.
let calls = 0; let resets = 0;
const r1 = await fetchEngineToolsWithRetry(
  async () => { calls++; if (calls < 2) throw new Error("cold connection"); return LIVE; },
  () => { resets++; },
  { attempts: 3, sleep: noSleep },
);
check("retries a cold first call and returns the live list", r1 !== null && r1!.some((t) => t.name === "join_omega_lobby"));
check("reset was called between attempts", resets >= 1);

// All attempts fail → null (caller then uses cache/fallback).
let calls2 = 0;
const r2 = await fetchEngineToolsWithRetry(
  async () => { calls2++; throw new Error("engine down"); },
  () => {},
  { attempts: 3, sleep: noSleep },
);
check("returns null when every attempt fails", r2 === null);
check("made exactly `attempts` tries", calls2 === 3);

// An empty list is a miss (retry), not a success.
let calls3 = 0;
const r3 = await fetchEngineToolsWithRetry(
  async () => { calls3++; return calls3 < 3 ? [] : LIVE; },
  () => {},
  { attempts: 3, sleep: noSleep },
);
check("empty list is retried until a real list arrives", r3 !== null && r3!.length === 3);

// First-try success → no reset, no retry.
let calls4 = 0; let resets4 = 0;
const r4 = await fetchEngineToolsWithRetry(
  async () => { calls4++; return LIVE; },
  () => { resets4++; },
  { attempts: 3, sleep: noSleep },
);
check("first-try success returns immediately, no reset", r4 !== null && calls4 === 1 && resets4 === 0);

console.log(`\nSummary: passed ${passed}, failed ${failed}`);
process.exit(failed > 0 ? 1 : 0);
