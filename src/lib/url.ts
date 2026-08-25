/**
 * The outbound-endpoint rule every dial-out feature shares — the MCP servers
 * TabRunner connects to and the webhook URLs run events POST to: https
 * anywhere, plain http only for loopback hosts. Plenty of local daemons speak
 * cleartext on 127.0.0.1, and nothing remote should ever ride unencrypted.
 */
export function validOutboundUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false;
  const host = url.hostname.toLowerCase();
  return host === "127.0.0.1" || host === "[::1]" || host === "::1" || host === "localhost" || host.endsWith(".localhost");
}
