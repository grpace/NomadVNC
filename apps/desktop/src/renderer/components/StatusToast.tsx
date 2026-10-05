import { AlertCircleIcon, CheckCircleIcon, DisconnectIcon, InfoIcon } from "./icons";

interface StatusToastProps {
  message: string;
  variant?: "info" | "success" | "error" | "connecting" | "disconnecting";
  onDismiss?: () => void;
}

function getToastIcon(variant: StatusToastProps["variant"]) {
  switch (variant) {
    case "success":
      return <CheckCircleIcon style={{ width: 16, height: 16 }} />;
    case "error":
      return <AlertCircleIcon style={{ width: 16, height: 16 }} />;
    case "disconnecting":
      return <DisconnectIcon style={{ width: 16, height: 16 }} />;
    default:
      return <InfoIcon style={{ width: 16, height: 16 }} />;
  }
}

function getToastClass(variant: StatusToastProps["variant"]): string {
  const base = "status-toast";

  switch (variant) {
    case "success":
      return `${base} status-toast--success`;
    case "error":
      return `${base} status-toast--error`;
    case "connecting":
      return `${base} status-toast--connecting`;
    case "disconnecting":
      return `${base} status-toast--disconnecting`;
    default:
      return base;
  }
}

export function StatusToast({ message, variant = "info", onDismiss }: StatusToastProps) {
  if (!message || message === "Idle") {
    return null;
  }

  return (
    <div className={getToastClass(variant)}>
      <span className="status-toast-icon">
        {getToastIcon(variant)}
      </span>
      <span className="status-toast-message">{message}</span>
      {onDismiss && (
        <button className="status-toast-close" onClick={onDismiss} title="Dismiss">
          <DisconnectIcon style={{ width: 14, height: 14 }} />
        </button>
      )}
    </div>
  );
}
