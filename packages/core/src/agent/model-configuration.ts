import { join } from "node:path";
import { ModelRuntime, readStoredCredential, type CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";

/** Explicit model selection; credentials may be referenced without copying them. */
export async function configuredAgentModel(agentDir: string): Promise<Pick<CreateAgentSessionOptions, "model" | "modelRuntime">> {
  const provider = process.env.PKU_STUDY_AGENT_PROVIDER?.trim();
  const modelId = process.env.PKU_STUDY_AGENT_MODEL?.trim();
  const authPath = process.env.PKU_STUDY_PI_AUTH_PATH?.trim();
  const modelsPath = process.env.PKU_STUDY_PI_MODELS_PATH?.trim() || join(agentDir, "models.json");
  if (!provider && !modelId && !authPath) return {};
  if (!provider || !modelId) throw configurationError("请同时设置 PKU_STUDY_AGENT_PROVIDER 和 PKU_STUDY_AGENT_MODEL");
  const credential = authPath ? readStoredCredential(provider, authPath) : undefined;
  if (authPath && !credential) throw configurationError(`指定 Pi 凭据文件中没有 ${provider} 的登录信息`);
  const runtime = await ModelRuntime.create({
    modelsPath,
    ...(authPath ? { credentials: {
      read: async (id: string) => id === provider ? credential : undefined,
      list: async () => credential ? [{ providerId: provider, type: credential.type }] : [],
      modify: async () => { throw configurationError("外部 Pi 凭据为只读；请在 Pi 中更新登录后重启服务"); },
      delete: async () => { throw configurationError("外部 Pi 凭据为只读"); },
    } } : { authPath: join(agentDir, "auth.json") }),
  });
  const model = runtime.getModel(provider, modelId);
  if (!model) throw configurationError(`未找到模型 ${provider}/${modelId}，请检查模型配置或目录`);
  if (!runtime.hasConfiguredAuth(provider)) throw configurationError(`模型 ${provider}/${modelId} 尚未配置凭据`);
  return { model, modelRuntime: runtime };
}
function configurationError(message: string) {
  return Object.assign(new Error(message), { code: "AGENT_MODEL_CONFIGURATION", statusCode: 503 });
}
