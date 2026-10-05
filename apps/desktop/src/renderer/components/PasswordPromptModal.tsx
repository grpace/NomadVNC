import { useEffect, useRef, useState, type FormEvent } from "react";

interface PasswordPromptModalProps {
  title: string;
  body: string;
  submitLabel?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

export function PasswordPromptModal({
  title,
  body,
  submitLabel = "Continue",
  onSubmit,
  onCancel,
}: PasswordPromptModalProps) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onCancel();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    onSubmit(value);
  }

  return (
    <div className="password-modal-backdrop" role="presentation" onClick={onCancel}>
      <div
        className="password-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="password-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="password-modal-title" className="password-modal__title">
          {title}
        </h2>
        <p className="password-modal__body">{body}</p>
        <form className="password-modal__form" onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            type="password"
            className="form-input password-modal__input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoComplete="off"
            placeholder="Leave blank if the server has no password"
          />
          <div className="password-modal__actions">
            <button type="button" className="btn btn--secondary" onClick={onCancel}>
              Cancel
            </button>
            <button type="submit" className="btn btn--primary">
              {submitLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
