import { describe, expect, it } from "vitest";
import { cleanIpcErrorMessage } from "./ipcErrors";

describe("cleanIpcErrorMessage", () => {
  it("strips Electron's invoke wrapper", () => {
    expect(
      cleanIpcErrorMessage("Error invoking remote method 'nomadvnc:startVncSession': Error: tailnet login incomplete"),
    ).toBe("tailnet login incomplete");
  });

  it("translates Chromium network codes", () => {
    expect(
      cleanIpcErrorMessage("Error invoking remote method 'nomadvnc:accountRequest': Error: net::ERR_NAME_NOT_RESOLVED"),
    ).toBe("the server address couldn't be found");
    expect(cleanIpcErrorMessage("net::ERR_SOMETHING_NEW")).toBe("network error (ERR_SOMETHING_NEW)");
  });

  it("names timeouts and leaves ordinary messages alone", () => {
    expect(cleanIpcErrorMessage("Error invoking remote method 'x': TimeoutError: The operation was aborted due to timeout")).toBe(
      "the request timed out",
    );
    expect(cleanIpcErrorMessage("Secure credential storage is unavailable on this system")).toBe(
      "Secure credential storage is unavailable on this system",
    );
  });
});
