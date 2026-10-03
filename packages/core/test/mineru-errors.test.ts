import { expect, it } from "vitest";
import { mineruFailureMessage } from "../src/documents/parsers/mineru-cloud-parser.js";

it("reads quiet CLI JSON failures without exposing signed URLs", () => {
  const message = mineruFailureMessage({ stdout: JSON.stringify({ results: [{ error: "Network error: https://upload.example/?secret=private" }] }) });
  expect(message).toContain("网络与代理");
  expect(message).not.toContain("private");
  expect(mineruFailureMessage({ code: "ENOENT" })).toContain("未找到");
  expect(mineruFailureMessage({ killed: true })).toContain("超时");
  expect(mineruFailureMessage({ stdout: JSON.stringify({ results: [{ error: "File exceeds Agent API 10 MB limit — set MINERU_TOKEN" }] }) })).toContain("大小或页数限制");
  expect(mineruFailureMessage({ stdout: JSON.stringify({ results: [{ error: "Pages exceed Agent API 20-page limit — set MINERU_TOKEN" }] }) })).toContain("分卷解析");
});
