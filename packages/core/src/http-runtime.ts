import { EnvHttpProxyAgent, install, setGlobalDispatcher } from "undici";

let configured = false;

/** Initialize once at application entry points, before SDK/cloud requests. */
export function configureCloudHttp(): void {
  if (configured) return;
  configured = true;
  if (!process.env.HTTPS_PROXY && !process.env.https_proxy && !process.env.HTTP_PROXY && !process.env.http_proxy) return;
  // Match fetch and dispatcher implementations. Importing the SDK brings its
  // own undici, so Node's --use-env-proxy alone does not configure SDK requests.
  setGlobalDispatcher(new EnvHttpProxyAgent({ headersTimeout: 300_000, bodyTimeout: 300_000 }));
  install();
}
