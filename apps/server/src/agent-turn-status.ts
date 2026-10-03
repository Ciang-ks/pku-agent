interface MessageStatus { role: string; stopReason?: string; errorMessage?: string }
/** SDK prompt() may resolve after an error message. Only the final attempt decides success. */
export function agentTurnFailure(messages: readonly MessageStatus[]): { code: string; message: string; retryable: boolean } | undefined {
  const last = messages.findLast(message => message.role === "assistant");
  if (!last || (last.stopReason !== "error" && last.stopReason !== "aborted")) return undefined;
  if (last.stopReason === "aborted") return { code: "AGENT_ABORTED", message: "本次生成已中止。已保存的课次内容仍然保留。", retryable: true };
  const detail = last.errorMessage ?? "";
  // Provider messages can contain sensitive request details; expose only safe categories.
  if (/401|403|unauthori[sz]ed|invalid.*(?:key|token)|authentication/i.test(detail))
    return { code: "AGENT_AUTH_FAILED", message: "模型认证失败，请检查当前模型的 API 凭据。", retryable: false };
  if (/429|quota|rate.limit|balance|credit/i.test(detail))
    return { code: "AGENT_RATE_LIMIT", message: "模型额度不足或请求受到限流，请检查额度后重试。", retryable: true };
  if (/connect|network|fetch|timeout|timed.out/i.test(detail))
    return { code: "AGENT_CONNECTION_FAILED", message: "无法连接模型服务，请检查所选模型、接口地址与网络。", retryable: true };
  return { code: "AGENT_REQUEST_FAILED", message: "模型请求失败，请检查模型配置后重试。", retryable: true };
}
