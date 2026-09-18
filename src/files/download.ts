import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";
import type { IncomingMessage } from "node:http";

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
export type OpenDownload = (
  url: string,
  signal: AbortSignal,
) => Promise<IncomingMessage>;

/** 只下载宿主绑定的 HTTPS 文件；固定已检查的 DNS 地址，不跟随重定向或系统代理。 */
export const openDownload: OpenDownload = async (value, signal) => {
  const url = downloadUrl(value);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const dnsSignal = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
  const addresses = await new Promise<{ address: string; family: number }[]>(
    (resolve, reject) => {
      const abort = () => reject(new Error("文件地址解析被取消或超时。"));
      if (dnsSignal.aborted) {
        abort();
        return;
      }
      dnsSignal.addEventListener("abort", abort, { once: true });
      const task = isIP(host)
        ? Promise.resolve([{ address: host, family: isIP(host) }])
        : lookup(host, { all: true, verbatim: true });
      void task
        .then(resolve, () => reject(new Error("无法解析宿主文件地址。")))
        .finally(() => dnsSignal.removeEventListener("abort", abort));
    },
  );
  signal.throwIfAborted();
  if (
    !addresses.length ||
    addresses.some((item) => !isPublicAddress(item.address))
  )
    throw new Error("宿主文件地址不得指向本机、私网或保留地址。");
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: "GET",
        signal,
        agent: false,
        headers: { "Accept-Encoding": "identity" },
        lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, addresses);
          else callback(null, addresses[0]!.address, addresses[0]!.family);
        },
      },
      (response) => {
        if (
          response.statusCode !== 200 ||
          (response.headers["content-encoding"] &&
            response.headers["content-encoding"] !== "identity")
        ) {
          response.destroy();
          reject(
            new Error(
              `文件下载被拒绝（HTTP ${response.statusCode ?? 0}）；不跟随重定向。`,
            ),
          );
        } else resolve(response);
      },
    );
    req.on("error", () =>
      reject(new Error("文件下载连接失败或取消；下载凭据未回显。")),
    );
    req.end();
  });
};
