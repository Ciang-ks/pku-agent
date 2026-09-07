import type {
  ToolResult,
  TreeholeAuthState,
  TreeholeComment,
  TreeholePost,
  TreeholeSearchResult,
} from "../../domain/types.js";

export interface TreeholeLoginInput {
  username: string;
  password: string;
  verificationCode?: string;
}

export interface TreeholeAuthStatus {
  provider: "treehole";
  authState: TreeholeAuthState;
  detail?: string;
  updatedAt: string;
}

export interface TreeholeSearchInput {
  keyword: string;
  page?: number;
  limit?: number;
  commentLimit?: number;
}

export interface TreeholeProvider {
  authStatus(): Promise<ToolResult<TreeholeAuthStatus>>;
  login(input: TreeholeLoginInput): Promise<ToolResult<TreeholeAuthStatus>>;
  searchPosts(input: TreeholeSearchInput): Promise<ToolResult<TreeholeSearchResult>>;
  getPost(pid: string): Promise<ToolResult<TreeholePost>>;
  getComments(pid: string, page?: number, limit?: number): Promise<ToolResult<TreeholeComment[]>>;
}

export interface HttpTreeholeProviderOptions {
  baseUrl: string;
  getHeaders?: () => HeadersInit | Promise<HeadersInit | undefined>;
  login?: (input: TreeholeLoginInput) => Promise<HeadersInit | undefined>;
  oauthLoginUrl?: string;
  ssoLoginUrl?: string;
  loginByTokenUrl?: string;
  loginByMessageUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Minimal adapter for the public treehole endpoints. Credentials are supplied
 * by a caller-owned resolver and are never written by this class.
 */
export class HttpTreeholeProvider implements TreeholeProvider {
  private sessionHeaders?: HeadersInit;

  constructor(private readonly options: HttpTreeholeProviderOptions) {}

  async authStatus(): Promise<ToolResult<TreeholeAuthStatus>> {
    const now = new Date().toISOString();
    const headers = await this.headers();
    if (!headers) return { ok: true, data: { provider: "treehole", authState: "needs_password", updatedAt: now } };
    const result = await this.request("/chapi/api/v3/hole/list_comments", {
      keyword: "课程",
      page: "1",
      limit: "1",
      comment_limit: "0",
    });
    if (result.ok) return { ok: true, data: { provider: "treehole", authState: "ready", updatedAt: now } };
    const authState: TreeholeAuthStatus["authState"] = result.error.code === "TREEHOLE_AUTH_EXPIRED"
      ? "expired"
      : "error";
    return { ok: true, data: { provider: "treehole", authState, detail: result.error.message, updatedAt: now } };
  }

  async login(input: TreeholeLoginInput): Promise<ToolResult<TreeholeAuthStatus>> {
    try {
      const headers = this.options.login
        ? await this.options.login(input)
        : await this.loginWithPkuIaaa(input);
      if (!headers) return treeholeError("TREEHOLE_LOGIN_FAILED", "Treehole login did not return a session.", true);
      this.sessionHeaders = headers;
      return {
        ok: true,
        data: { provider: "treehole", authState: "ready", updatedAt: new Date().toISOString() },
      };
    } catch (error) {
      if (error instanceof TreeholeProviderError) {
        return treeholeError(error.code, error.message, error.retryable);
      }
      return treeholeError("TREEHOLE_LOGIN_FAILED", "Treehole login failed.", true);
    }
  }

  async searchPosts(input: TreeholeSearchInput): Promise<ToolResult<TreeholeSearchResult>> {
    const result = await this.request("/chapi/api/v3/hole/list_comments", {
      keyword: input.keyword,
      page: String(input.page ?? 1),
      limit: String(input.limit ?? 20),
      comment_limit: String(input.commentLimit ?? 10),
    });
    if (!result.ok) return result;
    const posts = parsePosts(result.data);
    return { ok: true, data: { keyword: input.keyword, posts } };
  }

  async getPost(pid: string): Promise<ToolResult<TreeholePost>> {
    const result = await this.searchPosts({ keyword: pid, limit: 40, commentLimit: 10 });
    if (!result.ok) return result;
    const post = result.data.posts.find((item) => item.pid === pid);
    return post
      ? { ok: true, data: post }
      : treeholeError("TREEHOLE_POST_NOT_FOUND", "Treehole post not found.", false);
  }

  async getComments(pid: string, page = 1, limit = 50): Promise<ToolResult<TreeholeComment[]>> {
    const result = await this.request(`/chapi/api/v3/hole/${encodeURIComponent(pid)}/comments`, {
      page: String(page),
      limit: String(limit),
    });
    if (!result.ok) return result;
    return { ok: true, data: parseComments(result.data) };
  }

  private async headers(): Promise<HeadersInit | undefined> {
    if (this.sessionHeaders) return this.sessionHeaders;
    return this.options.getHeaders ? this.options.getHeaders() : undefined;
  }

  private async loginWithPkuIaaa(input: TreeholeLoginInput): Promise<HeadersInit> {
    const base = new URL(this.options.baseUrl);
    const oauthLoginUrl = this.options.oauthLoginUrl ?? "https://iaaa.pku.edu.cn/iaaa/oauthlogin.do";
    const ssoLoginUrl = this.options.ssoLoginUrl ?? new URL("/cas_iaaa_login", base).toString();
    const loginByTokenUrl = this.options.loginByTokenUrl ?? new URL("/api/login_iaaa_check_token", base).toString();
    const loginByMessageUrl = this.options.loginByMessageUrl ?? new URL("/api/jwt_msg_verify", base).toString();
    const oauthBody = new URLSearchParams({
      appid: "PKU Helper",
      userName: input.username,
      password: input.password,
      randCode: "",
      smsCode: "",
      otpCode: "",
      redirUrl: new URL("/cas_iaaa_login?plat=web", base).toString(),
    });
    const oauth = await this.authRequest(oauthLoginUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: oauthBody.toString(),
    });
    if (!loginSucceeded(oauth.body)) {
      throw new TreeholeProviderError("TREEHOLE_LOGIN_REJECTED", "Treehole rejected the supplied PKU credentials.", false);
    }
    const token = readToken(oauth.body);
    if (!token) throw new TreeholeProviderError("TREEHOLE_LOGIN_FAILED", "PKU OAuth did not return an SSO token.", true);
    const sso = await this.authRequest(`${ssoLoginUrl}?${new URLSearchParams({ uuid: cryptoRandomId(), plat: "web", _rand: Math.random().toString(), token })}`, {
      method: "GET",
    });
    const authorization = readToken(sso.body) ?? readTokenFromUrl(sso.url);
    if (!authorization) {
      throw new TreeholeProviderError("TREEHOLE_LOGIN_FAILED", "Treehole SSO did not return an authorization token.", true);
    }
    let headers: HeadersInit = { authorization: `Bearer ${authorization}` };
    let authCheck = await this.authCheck(headers);
    if (loginSucceeded(authCheck)) return headers;

    if (!input.verificationCode) {
      throw new TreeholeProviderError(
        "TREEHOLE_VERIFICATION_REQUIRED",
        "Treehole requires a mobile or SMS verification code. Submit the same credentials again with the code.",
        true,
      );
    }
    const verificationUrl = /短信|sms|message/i.test(loginMessage(authCheck)) ? loginByMessageUrl : loginByTokenUrl;
    const verificationBody = verificationUrl === loginByMessageUrl
      ? new URLSearchParams({ valid_code: input.verificationCode })
      : new URLSearchParams({ code: input.verificationCode });
    const verification = await this.authRequest(verificationUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...normalizeHeaders(headers),
      },
      body: verificationBody.toString(),
    });
    const verifiedToken = readToken(verification.body);
    if (verifiedToken) headers = { authorization: `Bearer ${verifiedToken}` };
    authCheck = await this.authCheck(headers);
    if (!loginSucceeded(authCheck)) {
      throw new TreeholeProviderError("TREEHOLE_VERIFICATION_FAILED", "Treehole did not accept the verification code.", true);
    }
    return headers;
  }

  private async authCheck(headers: HeadersInit): Promise<unknown> {
    const base = new URL(this.options.baseUrl);
    const response = await this.authRequest(new URL("/api/mail/un_read", base).toString(), {
      method: "GET",
      headers,
    });
    return response.body;
  }

  private async authRequest(url: string, init: RequestInit): Promise<{ body: unknown; url: string }> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 15_000);
    try {
      const response = await fetchImpl(url, { ...init, signal: controller.signal });
      const body = await response.json().catch(() => undefined) as unknown;
      if (!response.ok) {
        throw new TreeholeProviderError("TREEHOLE_LOGIN_FAILED", "Treehole login request failed.", true);
      }
      return { body, url: response.url || url };
    } catch (error) {
      if (error instanceof TreeholeProviderError) throw error;
      throw new TreeholeProviderError(
        error instanceof DOMException && error.name === "AbortError" ? "TREEHOLE_TIMEOUT" : "TREEHOLE_UNAVAILABLE",
        "Treehole login is temporarily unavailable.",
        true,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async request(path: string, params: Record<string, string>): Promise<ToolResult<unknown>> {
    const headers = await this.headers();
    if (!headers) return treeholeError("TREEHOLE_AUTH_REQUIRED", "Treehole authentication is not configured.", true);
    const url = new URL(path, this.options.baseUrl.endsWith("/") ? this.options.baseUrl : `${this.options.baseUrl}/`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 15_000);
    try {
      const response = await fetchImpl(url, { headers, signal: controller.signal });
      if (response.status === 401 || response.status === 403) {
        return treeholeError("TREEHOLE_AUTH_EXPIRED", "Treehole authentication has expired.", true);
      }
      if (!response.ok) return treeholeError("TREEHOLE_HTTP_FAILED", "Treehole request failed.", true);
      const body = await response.json() as unknown;
      if (isRecord(body) && typeof body.code === "number" && body.code !== 20000) {
        return treeholeError("TREEHOLE_API_FAILED", "Treehole returned an error.", true);
      }
      return { ok: true, data: isRecord(body) && "data" in body ? body.data : body };
    } catch (error) {
      return treeholeError(error instanceof DOMException && error.name === "AbortError" ? "TREEHOLE_TIMEOUT" : "TREEHOLE_UNAVAILABLE", "Treehole is temporarily unavailable.", true);
    } finally {
      clearTimeout(timer);
    }
  }
}

class TreeholeProviderError extends Error {
  constructor(readonly code: string, message: string, readonly retryable: boolean) {
    super(message);
  }
}

export class UnconfiguredTreeholeProvider implements TreeholeProvider {
  authStatus(): Promise<ToolResult<TreeholeAuthStatus>> {
    return Promise.resolve({
      ok: true,
      data: {
        provider: "treehole",
        authState: "error",
        detail: "Configure a TreeholeProvider before using live search.",
        updatedAt: new Date().toISOString(),
      },
    });
  }

  login(): Promise<ToolResult<TreeholeAuthStatus>> {
    return Promise.resolve(treeholeError("TREEHOLE_NOT_CONFIGURED", "Treehole search is not configured.", false));
  }

  searchPosts(): Promise<ToolResult<TreeholeSearchResult>> {
    return Promise.resolve(treeholeError("TREEHOLE_NOT_CONFIGURED", "Treehole search is not configured.", false));
  }

  getPost(): Promise<ToolResult<TreeholePost>> {
    return Promise.resolve(treeholeError("TREEHOLE_NOT_CONFIGURED", "Treehole search is not configured.", false));
  }

  getComments(): Promise<ToolResult<TreeholeComment[]>> {
    return Promise.resolve(treeholeError("TREEHOLE_NOT_CONFIGURED", "Treehole search is not configured.", false));
  }
}

function parsePosts(value: unknown): TreeholePost[] {
  const list = isRecord(value) && Array.isArray(value.list) ? value.list : Array.isArray(value) ? value : [];
  return list.flatMap((item) => {
    if (!isRecord(item) || (typeof item.pid !== "string" && typeof item.pid !== "number") || typeof item.text !== "string") return [];
    return [{
      pid: String(item.pid),
      text: item.text,
      commentCount: typeof item.comment_total === "number" ? item.comment_total : 0,
      comments: Array.isArray(item.comment_list) ? parseComments(item.comment_list) : [],
    } satisfies TreeholePost];
  });
}

function parseComments(value: unknown): TreeholeComment[] {
  const list = isRecord(value) && Array.isArray(value.list) ? value.list : Array.isArray(value) ? value : [];
  return list.flatMap((item, index) => {
    if (!isRecord(item) || typeof item.text !== "string") return [];
    const id = typeof item.cid === "string" || typeof item.cid === "number" ? String(item.cid) : `comment-${index + 1}`;
    return [{
      commentId: id,
      text: item.text,
      ...(typeof item.created_at === "string" ? { createdAt: item.created_at } : {}),
    } satisfies TreeholeComment];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readToken(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.token === "string" && value.token.trim()) return value.token.trim();
  if (isRecord(value.data) && typeof value.data.token === "string" && value.data.token.trim()) return value.data.token.trim();
  return undefined;
}

function loginSucceeded(value: unknown): boolean {
  return isRecord(value) && (value.success === true || value.success === "true" || value.code === 20000);
}

function loginMessage(value: unknown): string {
  if (!isRecord(value)) return "";
  return typeof value.message === "string" ? value.message : typeof value.msg === "string" ? value.msg : "";
}

function normalizeHeaders(headers: HeadersInit): Record<string, string> {
  return Object.fromEntries(new Headers(headers).entries());
}

function readTokenFromUrl(url: string): string | undefined {
  try {
    return new URL(url).searchParams.get("token")?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function cryptoRandomId(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto?.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("") || Math.random().toString(16).slice(2);
}

function treeholeError<T>(code: string, message: string, retryable: boolean): ToolResult<T> {
  return { ok: false, error: { code, message, retryable } };
}
