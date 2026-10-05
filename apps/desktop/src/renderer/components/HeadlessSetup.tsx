import { useState } from "react";
import { SERVER_SETUP_BLOCKS, buildCopyText } from "../serverSetup";

/**
 * Headless-server onboarding rendered at the bottom of the connection form:
 * copy-paste essentials for bringing a Linux box into the tailnet with a
 * VNC server on display :1 (port 5901). Full automation lives in
 * `scripts/setup-linux-server.sh`.
 */
export function HeadlessSetup() {
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
        {expanded ? "Hide Headless Setup Guide" : "Setting Up a Headless Server?"}
      </button>

      {expanded && (
        <div className="headless-setup__steps">
          <p className="form-hint">
            Run step 0 on the Linux box for the automated setup, or work
            through steps 1–4 by hand, then refresh devices above and pick it.
            Verify anytime with ./setup-linux-server.sh --status.
          </p>
          {SERVER_SETUP_BLOCKS.map((block) => (
            <section key={block.id} className="headless-setup__step">
              <div className="headless-setup__step-head">
                <h4 className="headless-setup__title">{block.title}</h4>
                <button
                  className="btn btn--secondary btn--sm"
                  onClick={() => void handleCopy(block.id, buildCopyText(block))}
                  title={`Copy ${block.title} commands`}
                >
                  {copiedId === block.id ? "Copied" : "Copy"}
                </button>
              </div>
              <p className="form-hint">{block.body}</p>
              <pre className="headless-setup__commands">{buildCopyText(block)}</pre>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
