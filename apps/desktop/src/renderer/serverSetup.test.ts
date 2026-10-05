import { describe, expect, it } from "vitest";
import {
  SERVER_SETUP_BLOCKS,
  buildCopyText,
  describeSetupCommand,
} from "./serverSetup";

describe("serverSetup", () => {
  it("covers the full headless path in order", () => {
    expect(SERVER_SETUP_BLOCKS.map((block) => block.id)).toEqual([
      "one-command",
      "tailscale",
      "vnc-server",
      "autostart",
      "firewall-pair",
    ]);
  });

  it("gives every block a title, body, and commands", () => {
    for (const block of SERVER_SETUP_BLOCKS) {
      expect(block.title.trim()).not.toBe("");
      expect(block.body.trim()).not.toBe("");
      expect(block.commands.length).toBeGreaterThan(0);
    }
  });

  it("mentions the tools that matter exactly where they are needed", () => {
    const all = describeSetupCommand();
    expect(all).toContain("tailscale up");
    expect(all).toContain("tigervnc");
    expect(all).toContain("vncpasswd");
    expect(all).toContain("systemctl --user enable --now");
    expect(all).toContain("loginctl enable-linger");
    expect(all).toContain("5901");
    // Display :1 is port 5901, and the server must listen past loopback.
    expect(all).toContain("-localhost no");
  });

  it("never embeds a password or token", () => {
    const all = describeSetupCommand().toLowerCase();
    expect(all).not.toContain("password=");
    expect(all).not.toContain("--authkey");
    expect(all).not.toContain("tskey-");
  });

  it("copies blocks verbatim so distro comments survive", () => {
    const vnc = SERVER_SETUP_BLOCKS.find((block) => block.id === "vnc-server");
    if (!vnc) {
      throw new Error("vnc-server block missing");
    }
    expect(buildCopyText(vnc)).toContain("# Fedora / RHEL");
    expect(buildCopyText(vnc)).toContain("vncpasswd");
  });

  it("scopes the firewall to tailnet traffic, never the open internet", () => {
    const fw = SERVER_SETUP_BLOCKS.find((block) => block.id === "firewall-pair");
    if (!fw) {
      throw new Error("firewall-pair block missing");
    }
    const text = buildCopyText(fw);
    expect(text).toContain("100.64.0.0/10");
    expect(text).toContain("tailscale0");
    expect(text).not.toContain("--add-port=5901/tcp");
  });

  it("offers the one-command script first with a status check", () => {
    const first = SERVER_SETUP_BLOCKS[0];
    expect(first.id).toBe("one-command");
    const text = buildCopyText(first);
    expect(text).toContain("setup-linux-server.sh");
    expect(first.body).toContain("--status");
  });
});
