import { createServer } from "./server.js";

const host = process.env.PKU_STUDY_HOST ?? "127.0.0.1";
const port = Number(process.env.PKU_STUDY_PORT ?? "4317");
const instance = await createServer();

await instance.server.listen({ host, port });
instance.server.log.info({ tokenPath: instance.app.paths.tokenPath }, "Local API token ready");

const shutdown = async (): Promise<void> => {
  await instance.close();
  process.exit(0);
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
