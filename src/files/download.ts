import { lookup } from "node:dns/promises";
import { BlockList, isIP, type LookupFunction } from "node:net";
import type { IncomingHttpHeaders } from "node:http";
import type { Readable } from "node:stream";
import { EnvironmentHttpClient } from "../network/http.js";

const blocked4 = new BlockList();
for (const [ip, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked4.addSubnet(ip, prefix, "ipv4");
const global6 = new BlockList();
global6.addSubnet("2000::", 3, "ipv6");
const blocked6 = new BlockList();
for (const [ip, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const)
  blocked6.addSubnet(ip, prefix, "ipv6");
export function isPublicAddress(ip: string): boolean {
  if (isIP(ip) === 4) return !blocked4.check(ip, "ipv4");
  return (
    isIP(ip) === 6 && global6.check(ip, "ipv6") && !blocked6.check(ip, "ipv6")
  );
}
export function downloadUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("宿主文件地址无效。");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== "443")
  )
    throw new Error("宿主文件地址必须是无凭据、无片段的 HTTPS 443 地址。");
  return url;
}
export type DownloadResponse = Readable & { headers: IncomingHttpHeaders };
export type OpenDownload = (
  url: string,
  signal: AbortSignal,
) => Promise<DownloadResponse>;

/** Direct connections resolve once and return only verified public addresses.
 * Explicit proxies resolve destination hostnames themselves; their routing is trusted.
 */
export const publicLookup: LookupFunction = (hostname, options, callback) => {
  let completed = false;
  const timer = setTimeout(() => finish(new Error("文件地址解析超时。")), 5000);
  timer.unref();
  function finish(
    error: Error | null,
    addresses: { address: string; family: number }[] = [],
  ) {
    if (completed) return;
    completed = true;
    clearTimeout(timer);
    if (error) callback(error, "", 0);
    else if (options.all) callback(null, addresses);
    else callback(null, addresses[0]!.address, addresses[0]!.family);
  }
  void lookup(hostname, { all: true, verbatim: true }).then(
    (addresses) => {
      if (
        !addresses.length ||
        addresses.some((item) => !isPublicAddress(item.address))
      )
        finish(new Error("宿主文件地址不得指向本机、私网或保留地址。"));
      else finish(null, addresses);
    },
    () => finish(new Error("无法解析宿主文件地址。")),
  );
};

/** Stream through the user's proxy settings on Node 20/22/24, never redirect or silently retry direct. */
export const openDownload: OpenDownload = async (value, signal) => {
  signal.throwIfAborted();
  const url = downloadUrl(value);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && !isPublicAddress(host))
    throw new Error("宿主文件地址不得指向本机、私网或保留地址。");
  const client = new EnvironmentHttpClient(process.env, {
    directLookup: publicLookup,
  });
  let failure =
    "文件下载失败或取消（检查代理、地址和响应）；下载及代理凭据未回显，不直接重试。";
  try {
    const response = await client.get(url, signal);
    // Own abort/error events even when rejecting a response before a consumer attaches.
    const cleanup = () => {
      void client.close().catch(() => undefined);
    };
    response.body.once("end", cleanup);
    response.body.once("close", cleanup);
    response.body.once("error", cleanup);
    if (
      response.statusCode !== 200 ||
      (response.headers["content-encoding"] &&
        response.headers["content-encoding"] !== "identity")
    ) {
      response.body.destroy();
      failure = `文件下载被拒绝（HTTP ${response.statusCode}）；不跟随重定向。`;
      throw new Error(failure);
    }
    const body: DownloadResponse = Object.assign(response.body, {
      headers: response.headers,
    });
    return body;
  } catch {
    await client.close().catch(() => undefined);
    throw new Error(failure);
  }
};
