import {
  EnvHttpProxyAgent,
  request,
  type Dispatcher,
  type Agent,
} from "undici";
import type { LookupFunction } from "node:net";

export type Environment = Readonly<Record<string, string | undefined>>;

/** Owned HTTP transport, independent of Node's version-specific global proxy switches.
 * No global monkey-patching, environment mutation, TLS weakening or direct fallback.
 */
export class EnvironmentHttpClient {
  readonly #agent: EnvHttpProxyAgent;
  #closing: Promise<void> | undefined;

  constructor(
    env: Environment = process.env,
    options: { directLookup?: LookupFunction } = {},
  ) {
    const connect: Agent.Options["connect"] = options.directLookup
      ? { lookup: options.directLookup }
      : {};
    try {
      this.#agent = new EnvHttpProxyAgent({
        httpProxy: env.http_proxy ?? env.HTTP_PROXY ?? "",
        httpsProxy: env.https_proxy ?? env.HTTPS_PROXY ?? "",
        noProxy: env.no_proxy ?? env.NO_PROXY ?? "",
        connect,
        // SSE and downloads use their caller's AbortSignal, not a socket idle timeout.
        bodyTimeout: 0,
      });
    } catch {
      throw new Error(
        "The HTTP proxy settings are not valid. Check HTTP_PROXY, HTTPS_PROXY, and NO_PROXY. Proxy credentials are not shown.",
      );
    }
  }

  readonly fetch = (
    url: string | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    if (this.#closing)
      return Promise.reject(new Error("The HTTP client is closed."));
    // The dispatcher interface is supported by Node 20's fetch as well as 22/24.
    const options: RequestInit & { dispatcher: Dispatcher } = {
      ...init,
      dispatcher: this.#agent,
    };
    return globalThis.fetch(url, options);
  };

  get(url: URL, signal: AbortSignal) {
    if (this.#closing)
      return Promise.reject(new Error("The HTTP client is closed."));
    return request(url, {
      dispatcher: this.#agent,
      method: "GET",
      headers: { "accept-encoding": "identity" },
      // Undici request does not follow redirects without a redirect interceptor.
      bodyTimeout: 0,
      signal,
    });
  }

  close(): Promise<void> {
    // Callers cancel outstanding work before closing; destroy also releases idle sockets.
    this.#closing ??= this.#agent.destroy();
    return this.#closing;
  }
}
