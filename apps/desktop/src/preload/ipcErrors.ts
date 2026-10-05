/**
 * User-facing text for errors that crossed the IPC bridge.
 *
 * `ipcRenderer.invoke` rejects with "Error invoking remote method
 * '<channel>': Error: <message>", and Chromium network failures arrive as
 * bare `net::ERR_*` codes. Both reached toasts verbatim; this strips the
 * plumbing and translates the common network codes.
 */

const IPC_PREFIX = /^Error invoking remote method '[^']*': (?:[A-Za-z]*Error: )?/;

const NETWORK_ERRORS: Record<string, string> = {
  ERR_CONNECTION_REFUSED: "the server refused the connection",
  ERR_CONNECTION_RESET: "the connection was reset",
  ERR_CONNECTION_TIMED_OUT: "the connection timed out",
  ERR_TIMED_OUT: "the request timed out",
  ERR_NAME_NOT_RESOLVED: "the server address couldn't be found",
  ERR_INTERNET_DISCONNECTED: "this computer is offline",
  ERR_NETWORK_CHANGED: "the network changed. Try again",
  ERR_ADDRESS_UNREACHABLE: "the server is unreachable",
  ERR_UNSAFE_PORT: "that port is blocked for web requests. Use the server's normal HTTPS address",
  ERR_CERT_AUTHORITY_INVALID: "the server's certificate isn't trusted",
  ERR_CERT_COMMON_NAME_INVALID: "the server's certificate doesn't match its address",
  ERR_CERT_DATE_INVALID: "the server's certificate has expired",
};

export function cleanIpcErrorMessage(message: string): string {
  const stripped = message.replace(IPC_PREFIX, "").trim();
  const code = /net::(ERR_[A-Z_]+)/.exec(stripped)?.[1];
  if (code) {
    return NETWORK_ERRORS[code] ?? `network error (${code})`;
  }
  if (/TimeoutError|The operation was aborted due to timeout/.test(stripped)) {
    return "the request timed out";
  }
  return stripped || message;
}
