import { expect, it } from "vitest";
import { agentTurnFailure } from "../src/agent-turn-status.js";
it("reports SDK errors that do not reject prompt()", () => {
  expect(agentTurnFailure([{ role: "user" }, { role: "assistant", stopReason: "error", errorMessage: "Connection error." }])?.code).toBe("AGENT_CONNECTION_FAILED");
});
it("allows a successful retry and redacts provider details", () => {
  expect(agentTurnFailure([{ role: "assistant", stopReason: "error" }, { role: "assistant", stopReason: "stop" }])).toBeUndefined();
  const failure = agentTurnFailure([{ role: "assistant", stopReason: "error", errorMessage: "401 invalid token secret-value" }]);
  expect(failure?.code).toBe("AGENT_AUTH_FAILED");
  expect(JSON.stringify(failure)).not.toContain("secret-value");
});
