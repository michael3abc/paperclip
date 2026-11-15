import { networkInterfaces } from "node:os";

export interface NativeMcpLaunchBinding {
  name: string;
  url: string;
  token: string;
}

/** Plain HTTP to an address assigned to this host never leaves the machine, like loopback
 * (Owner 2026-11-15: Paperclip listens only on its LAN address). */
function hostOwnsAddress(hostname: string, addresses: () => string[]): boolean {
  const host = hostname.replace(/^\[|\]$/g, "");
  return addresses().includes(host);
}

function localInterfaceAddresses(): string[] {
  return Object.values(networkInterfaces()).flatMap(list => (list ?? []).map(entry => entry.address));
}

export function nativeMcpLaunchBinding(
  environment: NodeJS.ProcessEnv = process.env,
  interfaceAddresses: () => string[] = localInterfaceAddresses,
): NativeMcpLaunchBinding | null {
  const name = environment.PAPERCLIP_NATIVE_MCP_NAME?.trim();
  const url = environment.PAPERCLIP_NATIVE_MCP_URL?.trim();
  const token = environment.PAPERCLIP_NATIVE_MCP_TOKEN?.trim();
  if (!name && !url && !token) return null;
  if (
    !name
    || !url
    || !token
    || token.length < 32
    || token.length > 4096
    || url.length > 2048
  ) {
    throw new Error("assigned native MCP launch binding is incomplete");
  }
  if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(name)) {
    throw new Error("assigned native MCP name is invalid");
  }
  const endpoint = new URL(url);
  if (endpoint.username || endpoint.password || endpoint.hash) {
    throw new Error("assigned native MCP endpoint contains forbidden URL data");
  }
  if (
    endpoint.protocol !== "https:"
    && !(endpoint.protocol === "http:"
      && (["127.0.0.1", "localhost"].includes(endpoint.hostname) || hostOwnsAddress(endpoint.hostname, interfaceAddresses)))
  ) {
    throw new Error(
      "assigned native MCP endpoint requires HTTPS or loopback HTTP",
    );
  }
  return { name, url: endpoint.toString(), token };
}
