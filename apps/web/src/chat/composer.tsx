export function Composer({
  value,
  onChange,
  onSubmit,
  disabled,
  canSubmit,
  providerNote,
  preparing = false,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  disabled: boolean;
  canSubmit: boolean;
  providerNote: string;
  preparing?: boolean;
}) {
  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        if (disabled || preparing || !canSubmit || !value.trim()) return;
        onSubmit();
      }}
    >
      <label className="sr-only" htmlFor="goal">
        What would you like to get done?
      </label>
      <textarea
        id="goal"
        rows={2}
        maxLength={10000}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Describe a task…"
      />
      <div className="composer-bottom">
        <span className="fine" role="status">
          {preparing ? "Preparing your task…" : providerNote}
        </span>
        <button
          aria-label={
            preparing ? "Preparing your task" : "Send · Create mission"
          }
          title="Send · Create mission"
          type="submit"
          disabled={disabled || preparing || !canSubmit || !value.trim()}
        >
          {preparing ? (
            "Preparing…"
          ) : (
            <>
              Send <span aria-hidden="true">↗</span>
            </>
          )}
        </button>
      </div>
    </form>
  );
}
