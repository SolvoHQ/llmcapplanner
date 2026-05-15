#!/usr/bin/env node
// Smoke test: spawn the MCP server, run the standard MCP JSON-RPC handshake,
// list tools, and invoke `llm_capacity_plan` against KNOWN ORACLE inputs
// derived from the llmcapplanner web app compute() logic.
// Prints each response as it arrives. Exits 0 on success, 1 on any failure.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = join(__dirname, "dist", "index.js");

const child = spawn("node", [serverPath], {
  stdio: ["pipe", "pipe", "inherit"],
});

let buffer = "";
const pending = new Map();
let nextId = 1;

function send(method, params, id = nextId++) {
  const msg = { jsonrpc: "2.0", id, method, params };
  child.stdin.write(JSON.stringify(msg) + "\n");
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
}

function sendNotification(method, params) {
  const msg = { jsonrpc: "2.0", method, params };
  child.stdin.write(JSON.stringify(msg) + "\n");
}

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id != null && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    } catch (e) {
      console.error("Failed to parse line:", line, e);
    }
  }
});

const failures = [];
function assertEq(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(
    `  [${ok ? "PASS" : "FAIL"}] ${label}: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`,
  );
  if (!ok) failures.push(label);
}
function assertApprox(label, actual, expected, tol) {
  const ok = Math.abs(actual - expected) <= tol;
  console.log(
    `  [${ok ? "PASS" : "FAIL"}] ${label}: actual=${actual} expected≈${expected} (±${tol})`,
  );
  if (!ok) failures.push(label);
}

try {
  const initResult = await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke-test", version: "0.0.0" },
  });
  console.log("\n=== initialize result ===");
  console.log(JSON.stringify(initResult, null, 2));

  sendNotification("notifications/initialized", {});

  const tools = await send("tools/list", {});
  console.log("\n=== tools/list result ===");
  console.log(JSON.stringify(tools, null, 2));
  if (
    !Array.isArray(tools.tools) ||
    !tools.tools.some((t) => t.name === "llm_capacity_plan")
  ) {
    throw new Error("llm_capacity_plan tool not found in tools/list response");
  }

  // ---- ORACLE 1: within limits, OTPM binds first ----
  const oracleInput = {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    tier: "t4",
    rpm: 600,
    in_tok: 2000,
    out_tok: 500,
  };
  console.log("\n=== calling llm_capacity_plan (ORACLE 1: anthropic/sonnet/t4) ===");
  console.log("input:", JSON.stringify(oracleInput));
  const r1 = await send("tools/call", {
    name: "llm_capacity_plan",
    arguments: oracleInput,
  });
  console.log("\n=== tools/call result (ORACLE 1) ===");
  console.log(JSON.stringify(r1, null, 2));
  if (r1.isError) throw new Error("ORACLE 1 returned isError=true");
  const s1 = r1.structuredContent;
  console.log("\n--- ORACLE 1 assertions ---");
  assertEq("monthly_cost", s1.monthly_cost, 349920);
  assertEq("monthly_cost_formatted", s1.monthly_cost_formatted, "$349,920.00");
  assertEq("first_binding_429_dim", s1.first_binding_429_dim, "OTPM");
  assertEq("headroom_per_dim", s1.headroom_per_dim, {
    RPM: 3400,
    ITPM: 800000,
    OTPM: 100000,
  });
  assertEq("will_429", s1.will_429, false);
  assertEq("snapshot_version", s1.snapshot_version, "2026-05-15");
  assertApprox("util RPM", s1.util_per_dim.RPM, 15, 0.001);
  assertApprox("util ITPM", s1.util_per_dim.ITPM, 60, 0.001);
  assertApprox("util OTPM", s1.util_per_dim.OTPM, 75, 0.001);

  // ---- ORACLE 2: will 429, ITPM binds first ----
  const oracleInput2 = { ...oracleInput, tier: "t1" };
  console.log("\n=== calling llm_capacity_plan (ORACLE 2: anthropic/sonnet/t1) ===");
  console.log("input:", JSON.stringify(oracleInput2));
  const r2 = await send("tools/call", {
    name: "llm_capacity_plan",
    arguments: oracleInput2,
  });
  console.log("\n=== tools/call result (ORACLE 2) ===");
  console.log(JSON.stringify(r2, null, 2));
  if (r2.isError) throw new Error("ORACLE 2 returned isError=true");
  const s2 = r2.structuredContent;
  console.log("\n--- ORACLE 2 assertions ---");
  assertEq("will_429", s2.will_429, true);
  assertEq("first_binding_429_dim", s2.first_binding_429_dim, "ITPM");

  // ---- ORACLE 3: invalid model -> helpful error-as-text ----
  console.log("\n=== calling llm_capacity_plan (ORACLE 3: invalid model) ===");
  const r3 = await send("tools/call", {
    name: "llm_capacity_plan",
    arguments: { ...oracleInput, model: "claude-nope-9" },
  });
  console.log(JSON.stringify(r3, null, 2));
  console.log("\n--- ORACLE 3 assertions ---");
  assertEq("invalid model isError", r3.isError, true);
  const r3text = r3.content?.[0]?.text || "";
  assertEq(
    "invalid model lists valid models",
    r3text.includes("claude-sonnet-4-6") && r3text.includes("claude-opus-4-7"),
    true,
  );

  if (failures.length) {
    console.error(`\n=== SMOKE TEST FAILED: ${failures.length} assertion(s) failed: ${failures.join(", ")} ===`);
    process.exitCode = 1;
  } else {
    console.log("\n=== SMOKE TEST PASSED (all oracle assertions matched exactly) ===");
  }
} catch (e) {
  console.error("Smoke test failed:", e);
  process.exitCode = 1;
} finally {
  child.kill("SIGTERM");
}
