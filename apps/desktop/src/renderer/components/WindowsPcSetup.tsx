import { useState } from "react";
import { WINDOWS_PC_SETUP_BLOCKS, buildCopyText } from "../serverSetup";

/**
 * Windows-PC onboarding rendered in Settings next to the headless Linux
 * guide. Copy buttons only appear on steps that have commands.
 */
export function WindowsPcSetup() {
  const [expanded, setExpanded] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  async function handleCopy(blockId: string, text: string): Promise<void> {
    try {
      await window.nomadNative.writeClipboard(text);
      setCopiedId(blockId);
      window.setTimeout(() => {
        setCopiedId((current) => (current === blockId ? null : current));
      }, 2000);
    } catch {
      // Clipboard bridge failures stay silent; the text remains selectable.
    }
  }

  return (
    <div className="headless-setup">
      <button
        className="btn btn--secondary btn--full"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
      >
        {expanded ? "Hide Windows PC Guide" : "Setting Up a Windows PC?"}
      </button>

      {expanded && (
        <div className="headless-setup__steps">
          <p className="form-hint">
            Four steps per PC: Tailscale, a VNC server, save it in
            NomadVNC, connect. Then share the card with anyone on your tailnet
            who needs access.
          </p>
          {WINDOWS_PC_SETUP_BLOCKS.map((block) => (
            <section key={block.id} className="headless-setup__step">
              <div className="headless-setup__step-head">
                <h4 className="headless-setup__title">{block.title}</h4>
                {block.commands.length > 0 ? (
                  <button
                    className="btn btn--secondary btn--sm"
                    onClick={() => void handleCopy(block.id, buildCopyText(block))}
                    title={`Copy ${block.title} commands`}
                  >
                    {copiedId === block.id ? "Copied" : "Copy"}
                  </button>
                ) : null}
              </div>
              <p className="form-hint">{block.body}</p>
              {block.commands.length > 0 && (
                <pre className="headless-setup__commands">
                  {buildCopyText(block)}
                </pre>
              )}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
