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
    throw new Error("The download_url of the file is not valid.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== "443")
  )
    throw new Error(
      "The download_url of the file must be an https URL on port 443 without a user name, password, or fragment.",
    );
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
  const timer = setTimeout(
    () =>
      finish(new Error("Resolving the host of the download_url timed out.")),
    5000,
  );
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
        finish(
          new Error(
            "The download_url of the file must not point to this machine, a private network, or a reserved address.",
          ),
        );
      else finish(null, addresses);
    },
    () => finish(new Error("Cannot resolve the host of the download_url.")),
  );
};

/** Stream through the user's proxy settings on Node 20/22/24, never redirect or silently retry direct. */
export const openDownload: OpenDownload = async (value, signal) => {
  signal.throwIfAborted();
  const url = downloadUrl(value);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && !isPublicAddress(host))
    throw new Error(
      "The download_url of the file must not point to this machine, a private network, or a reserved address.",
    );
  const client = new EnvironmentHttpClient(process.env, {
    directLookup: publicLookup,
  });
  let failure =
    "The file download failed or was cancelled. Check the proxy settings and that the link has not expired. The download link and proxy credentials are not shown. The download was not retried.";
  try {
    const response = await client.get(url, signal);
    // Own abort/error events even when rejecting a response before a consumer attaches.
    const cleanup = () => {
      void client.close().catch(() => undefined);
    };
    response.body.once("end", cleanup);
    response.body.once("close", cleanup);
    response.body.once("error", cleanup);
    const encoded =
      response.headers["content-encoding"] &&
      response.headers["content-encoding"] !== "identity";
    if (response.statusCode !== 200 || encoded) {
      response.body.destroy();
      failure =
        response.statusCode !== 200
          ? `The file download was refused (HTTP ${response.statusCode}). Redirects are not followed.`
          : "The file download used a Content-Encoding, which exec-mcp does not accept. The file was not saved.";
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
