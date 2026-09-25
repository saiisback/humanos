export function Composer({
  value,
  onChange,
  onSubmit,
  disabled,
  canSubmit,
  providerNote,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  disabled: boolean;
  canSubmit: boolean;
  providerNote: string;
}) {
  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
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
        <span className="fine">{providerNote}</span>
        <button
          aria-label="Create mission"
          title="Create mission"
          type="submit"
          disabled={disabled || !canSubmit || !value.trim()}
        >
          Send <span aria-hidden="true">↗</span>
        </button>
      </div>
    </form>
  );
}
