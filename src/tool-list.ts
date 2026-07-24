/**
 * tool-list.ts — decide which engine tool list to serve, robustly.
 *
 * The bug (openclaw): the server's tools/list makes a live call to the engine.
 * When that call fails or times out — which happens on openclaw's startup
 * discovery against a cold Streamable-HTTP engine — the handler fell back to a
 * STATIC list that predates OMEGA entirely. So the agent saw the Green Room
 * tools (fetched from a different, reachable host) but none of the OMEGA/contest
 * tools, and could not join OMEGA lobbies.
 *
 * Two robustness layers make this deterministic:
 *   • a last-good cache: once the real live list has been seen, a later transient
 *     failure serves that cached real list instead of the stale static fallback;
 *   • the static fallback is only the last resort (cold start + engine down).
 *
 * This module is the pure decision so it unit-tests without a network.
 */
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export type ToolListSource = "live" | "cache" | "fallback";

export interface ToolListChoice {
  tools: Tool[];
  source: ToolListSource;
}

/**
 * Pick the engine tool list to serve:
 *   1. a fresh live fetch (non-empty) — authoritative;
 *   2. else the last-good cached live list (non-empty) — real, just not fresh;
 *   3. else the static fallback — last resort.
 */
export function chooseToolList(
  fetched: Tool[] | null,
  cached: Tool[] | null,
  fallback: Tool[],
): ToolListChoice {
  if (fetched && fetched.length > 0) return { tools: fetched, source: "live" };
  if (cached && cached.length > 0) return { tools: cached, source: "cache" };
  return { tools: fallback, source: "fallback" };
}

/**
 * Fetch the engine tool list with a small number of attempts. A cold
 * Streamable-HTTP connection often fails the very first call and succeeds on a
 * retry, so retrying here (with a fresh connection via `reset`) turns a
 * transient miss into the real list instead of a degraded fallback.
 *
 * Returns the tools on success, or null if every attempt failed. Never throws.
 */
export async function fetchEngineToolsWithRetry(
  fetchOnce: () => Promise<Tool[]>,
  reset: () => void,
  opts: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<Tool[] | null> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const delayMs = opts.delayMs ?? 400;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  for (let i = 0; i < attempts; i++) {
    try {
      const tools = await fetchOnce();
      if (tools && tools.length > 0) return tools;
    } catch {
      /* fall through to retry */
    }
    // Reset the (probably half-open) connection before the next attempt.
    if (i < attempts - 1) {
      reset();
      await sleep(delayMs);
    }
  }
  return null;
}
