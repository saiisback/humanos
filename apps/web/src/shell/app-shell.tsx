import { useEffect, useRef, useState, type ReactNode } from "react";
import type {
  Mission,
  Readiness,
  RootIdentity,
  WalletAccount,
} from "@humanos/schemas";

const label = (value: string) =>
  value.toLowerCase().replaceAll("_", " ").replaceAll(".", " ");
type Sheet = "missions" | "identity" | "connections" | null;

export function AppShell({
  children,
  composer,
  missions,
  selectedId,
  onSelect,
  onNew,
  root,
  account,
  readiness,
  onSignOut,
  busy,
  error,
  onRetry,
}: {
  children: ReactNode;
  composer: ReactNode;
  missions: Mission[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  root: RootIdentity | null;
  account: WalletAccount | null;
  readiness: Readiness | null;
  onSignOut: () => void;
  busy: boolean;
  error: string;
  onRetry: () => void;
}) {
  const [sheet, setSheet] = useState<Sheet>(null);
  const [railOpen, setRailOpen] = useState(true);
  const trigger = useRef<HTMLElement | null>(null);
  const dialog = useRef<HTMLDialogElement | null>(null);
  function openSheet(next: Sheet) {
    trigger.current = document.activeElement as HTMLElement;
    setSheet(next);
  }
  function switchSheet(next: Sheet) {
    setSheet(next);
  }
  function closeSheet() {
    setSheet(null);
    requestAnimationFrame(() => trigger.current?.focus());
  }
  useEffect(() => {
    if (!sheet || !dialog.current) return;
    const element = dialog.current;
    element.showModal();
    element.querySelector<HTMLElement>("button")?.focus();
    return () => element.close();
  }, [sheet]);
  const missionList = (
    <>
      <h2>Missions</h2>
      <button
        className="rail-new"
        onClick={() => {
          onNew();
          closeSheet();
        }}
      >
        + New task
      </button>
      <nav aria-label="Missions">
        {missions.length ? (
          missions.map((mission) => (
            <button
              key={mission.id}
              aria-current={selectedId === mission.id ? "page" : undefined}
              className="mission-nav"
              onClick={() => {
                onSelect(mission.id);
                closeSheet();
              }}
            >
              <strong>{mission.title}</strong>
              <small>{label(mission.state)}</small>
            </button>
          ))
        ) : (
          <p className="fine">No missions yet.</p>
        )}
      </nav>
    </>
  );
  const identity = (
    <>
      <h2>Identity</h2>
      <p>
        <strong>JAW account</strong>
      </p>
      <p className="hash">{account?.address ?? "Not signed in"}</p>
      <p>
        <strong>World root</strong>
      </p>
      <p>
        {root
          ? `${root.ensName ?? root.id} · verified (${root.verificationEnvironment})`
          : "Not verified"}
      </p>
      {account && (
        <button className="secondary" disabled={busy} onClick={onSignOut}>
          Sign out
        </button>
      )}
    </>
  );
  const connections = (
    <>
      <h2>Connections</h2>
      <p className="fine">
        Configuration status is not proof of a completed provider operation.
      </p>
      {readiness?.services.map((service) => (
        <div className="connection" key={service.name}>
          <strong>{service.name}</strong>
          <span>{service.ready ? "Configured" : "Unavailable"}</span>
          {service.reason && <small>{service.reason}</small>}
        </div>
      )) ?? <p>Service status unavailable.</p>}
    </>
  );
  return (
    <div className={`app-shell ${railOpen ? "rail-open" : "rail-closed"}`}>
      <a className="skip" href="#main">
        Skip to workspace
      </a>
      <aside className="desktop-rail">
        <div className="brand">
          <span aria-hidden="true" className="brand-mark">
            ✳
          </span>{" "}
          HumanOS
        </div>
        {missionList}
        <div className="rail-secondary">
          <button onClick={() => openSheet("identity")}>Identity</button>
          <button onClick={() => openSheet("connections")}>Connections</button>
        </div>
      </aside>
      <div className="conversation-column">
        <header className="topbar">
          <button
            className="icon-button rail-toggle"
            aria-label={railOpen ? "Collapse missions" : "Expand missions"}
            onClick={() => setRailOpen(!railOpen)}
          >
            ☰
          </button>
          <button
            className="icon-button mobile-menu"
            aria-label="Open missions"
            onClick={() => openSheet("missions")}
          >
            ☰
          </button>
          <div className="topbar-title">
            <strong>HumanOS</strong>
            <small>
              {root
                ? "Human verified"
                : account
                  ? "JAW account connected"
                  : "Sign in required"}
            </small>
          </div>
          <button
            className="topbar-account"
            onClick={() => openSheet("identity")}
          >
            {account ? "Account" : "Identity"}
          </button>
          <button
            className="topbar-connections"
            onClick={() => openSheet("connections")}
          >
            Connections
          </button>
        </header>
        <div className="feedback-slot">
          {error && (
            <div className="error" role="alert">
              {error}{" "}
              <button className="text-button" disabled={busy} onClick={onRetry}>
                Retry connection
              </button>
            </div>
          )}
        </div>
        <main id="main" className="conversation-scroll">
          <div className="conversation-inner">{children}</div>
        </main>
        <div className="composer-slot">
          <div className="composer-inner">{composer}</div>
        </div>
      </div>
      {sheet && (
        <dialog
          ref={dialog}
          className="sheet"
          aria-label={sheet}
          onKeyDown={(event) => {
            if (event.key !== "Tab") return;
            const focusable = Array.from(
              event.currentTarget.querySelectorAll<HTMLElement>(
                'button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
              ),
            );
            const first = focusable[0];
            const last = focusable.at(-1);
            if (!first || !last) return;
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first.focus();
            }
          }}
          onCancel={(event) => {
            event.preventDefault();
            closeSheet();
          }}
        >
          <button
            className="sheet-close"
            aria-label={`Close ${sheet}`}
            onClick={closeSheet}
          >
            ×
          </button>
          {sheet === "missions" ? (
            <>
              {missionList}
              <nav
                className="sheet-secondary"
                aria-label="More workspace sections"
              >
                <button onClick={() => switchSheet("identity")}>
                  Identity
                </button>
                <button onClick={() => switchSheet("connections")}>
                  Connections
                </button>
              </nav>
            </>
          ) : sheet === "identity" ? (
            identity
          ) : (
            connections
          )}
        </dialog>
      )}
    </div>
  );
}
