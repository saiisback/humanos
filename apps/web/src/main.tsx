import { useEffect, useRef, useState } from "react";
import { mountApp } from "./mount";
import type {
  ApprovalRequestResponse,
  Capability,
  Mission,
  MissionDetailResponse,
  MissionListResponse,
  Readiness,
  WorldProofRequest,
} from "@humanos/schemas";
import { api } from "../lib/api";
import { useAuth } from "./auth/use-auth";
import { getBrowserJawProvider } from "./auth/jaw";
import { createE2EJawPermissionProvider } from "./auth/e2e-jaw";
import { createJawPermissionClient } from "./permissions/jaw-permissions";
import { Composer } from "./chat/composer";
import { buildTranscript } from "./chat/mission-flow";
import { Transcript, type TranscriptActions } from "./chat/transcript";
import { WorldVerification } from "./identity/world-verification";
import { AppShell } from "./shell/app-shell";
import { WorkflowWorkspace } from "./workflows/workspace";
import "@fontsource/dm-sans/400.css";
import "@fontsource/dm-sans/500.css";
import "@fontsource/dm-sans/600.css";
import "./style.css";

const terminal = ["COMPLETED", "REJECTED", "EXPIRED", "REVOKED", "FAILED"];
function App() {
  const auth = useAuth();
  const activeRoot = useRef<string | null>(null);
  activeRoot.current =
    auth.status === "signing-out" ? null : (auth.root?.id ?? null);
  const verifiedRequest = useRef<string | null>(null);
  const [ready, setReady] = useState<Readiness | null>(null);
  const [missions, setMissions] = useState<Mission[]>([]);
  const [detail, setDetail] = useState<MissionDetailResponse | null>(null);
  const [goal, setGoal] = useState(() => {
    try {
      return sessionStorage.getItem("humanos:conversation-draft") ?? "";
    } catch {
      return "";
    }
  });
  const [caps, setCaps] = useState<Capability[]>([]);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [proof, setProof] = useState<{
    request: WorldProofRequest;
    actionId?: string;
  } | null>(null);

  async function select(id: string) {
    const rootId = activeRoot.current;
    if (!rootId) return;
    const response = await api<MissionDetailResponse>(
      `/missions/${encodeURIComponent(id)}`,
    );
    if (activeRoot.current !== rootId) return;
    setDetail(response);
    setCaps(
      response.mission.approvedCapabilities.length
        ? response.mission.approvedCapabilities
        : response.mission.capabilities,
    );
    history.replaceState(null, "", `?mission=${encodeURIComponent(id)}`);
  }
  async function refresh() {
    setReady(await api<Readiness>("/ready"));
    if (!activeRoot.current) return;
    const rootId = activeRoot.current;
    const list = await api<MissionListResponse>("/missions");
    if (activeRoot.current !== rootId) return;
    setMissions(list.missions);
    const requested = new URLSearchParams(location.search).get("mission");
    if (requested) await select(requested);
    else if (
      detail &&
      list.missions.some((mission) => mission.id === detail.mission.id)
    )
      await select(detail.mission.id);
  }
  async function perform(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The request could not complete. Please retry.",
      );
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void perform(refresh).finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    try {
      sessionStorage.setItem("humanos:conversation-draft", goal);
    } catch {
      // Private storage failure does not prevent composing a task.
    }
  }, [goal]);
  useEffect(() => {
    if (!auth.root) {
      setMissions([]);
      setDetail(null);
      setProof(null);
      setCaps([]);
      return;
    }
    void perform(refresh);
  }, [auth.root?.id]);
  useEffect(() => {
    if (!detail || terminal.includes(detail.mission.state)) return;
    const id = detail.mission.id;
    const interval = setInterval(() => {
      void api<MissionDetailResponse>(`/missions/${encodeURIComponent(id)}`)
        .then((response) =>
          setDetail((current) =>
            current?.mission.id === id ? response : current,
          ),
        )
        .catch((cause) =>
          setError(cause instanceof Error ? cause.message : String(cause)),
        );
    }, 3000);
    return () => clearInterval(interval);
  }, [detail?.mission.id, detail?.mission.state]);
  async function createMission() {
    if (!auth.root || !goal.trim()) return;
    const response = await api<MissionDetailResponse>("/missions", {
      goal: goal.trim(),
    });
    setDetail(response);
    setCaps(response.mission.capabilities);
    setGoal("");
    history.replaceState(
      null,
      "",
      `?mission=${encodeURIComponent(response.mission.id)}`,
    );
    setMissions((await api<MissionListResponse>("/missions")).missions);
  }
  async function missionAction(action: string, body: unknown = {}) {
    if (!detail) return;
    setDetail(
      await api<MissionDetailResponse>(
        `/missions/${encodeURIComponent(detail.mission.id)}/${action}`,
        body,
      ),
    );
    setMissions((await api<MissionListResponse>("/missions")).missions);
  }
  async function actionMutation(
    actionId: string,
    path: string,
    reload = false,
  ) {
    const response = await api<MissionDetailResponse>(
      `/actions/${encodeURIComponent(actionId)}/${path}`,
      {},
    );
    if (reload && detail) await select(detail.mission.id);
    else setDetail(response);
  }
  const actions: TranscriptActions = {
    authorize: (capabilities) =>
      void perform(() =>
        missionAction("authorize", { approvedCapabilities: capabilities }),
      ),
    run: () => void perform(() => missionAction("run")),
    revoke: () => void perform(() => missionAction("revoke")),
    requestApproval: (actionId) =>
      void perform(async () => {
        const response = await api<ApprovalRequestResponse>(
          `/actions/${encodeURIComponent(actionId)}/approval/request`,
          {},
        );
        setProof({ request: response.request, actionId });
      }),
    confirm: (actionId) =>
      void perform(() => actionMutation(actionId, "confirm")),
    cancel: (actionId) =>
      void perform(() => actionMutation(actionId, "approval/cancel")),
    execute: (actionId) =>
      void perform(() => actionMutation(actionId, "execute", true)),
  };
  const transcript = buildTranscript(detail, ready);
  const jawProvider =
    import.meta.env.MODE === "e2e"
      ? createE2EJawPermissionProvider()
      : getBrowserJawProvider();
  const permissionClient =
    jawProvider && auth.account
      ? createJawPermissionClient(
          jawProvider,
          {
            record: (grant) => api("/jaw/permissions/record", { grant }),
            revoke: (id) =>
              api(`/jaw/permissions/${encodeURIComponent(id)}/revoke`, {
                success: true,
              }),
          },
          auth.account.address,
        )
      : undefined;
  if (auth.root)
    transcript.splice(0, 0, {
      kind: "identity",
      id: `root-${auth.root.id}`,
      text: `Proof of Human verified · ${auth.root.ensName ?? auth.root.id}`,
      verified: true,
    });
  const deepSeek = ready?.services.find((service) =>
    /deepseek/i.test(service.name),
  );
  const jev = ready?.services.find((service) => /jev/i.test(service.name));
  const providerNote = ready
    ? `DeepSeek ${deepSeek?.ready ? "configured" : "unavailable"} · Jev ${jev?.ready ? "configured" : "unavailable"}`
    : "Provider status unavailable";

  return (
    <>
      <AppShell
        missions={missions}
        selectedId={detail?.mission.id ?? null}
        onSelect={(id) => void perform(() => select(id))}
        onNew={() => {
          setDetail(null);
          history.replaceState(null, "", location.pathname);
        }}
        root={auth.root}
        account={auth.account}
        readiness={ready}
        onSignOut={() =>
          void perform(async () => {
            await auth.signOut();
            setGoal("");
          })
        }
        busy={busy}
        error={error}
        onRetry={() =>
          void perform(async () => {
            await auth.refresh();
            await refresh();
          })
        }
        composer={
          <Composer
            value={goal}
            onChange={setGoal}
            onSubmit={() => {
              setCreating(true);
              void perform(createMission).finally(() => setCreating(false));
            }}
            preparing={creating}
            disabled={busy || !auth.root}
            canSubmit={!!auth.root}
            providerNote={providerNote}
          />
        }
      >
        {loading || auth.status === "loading" ? (
          <p role="status" className="quiet-state">
            Connecting to your workspace…
          </p>
        ) : !auth.account ? (
          <section className="welcome" aria-label="Sign in">
            <div className="welcome-mark" aria-hidden="true">
              ✳
            </div>
            <h1>Make room for being human.</h1>
            <p>Delegate the work. Keep the final say.</p>
            <button
              disabled={
                busy || auth.status === "signing-in" || !auth.jawConfigured
              }
              onClick={() => void perform(auth.signIn)}
            >
              {auth.status === "signing-in"
                ? "Signing in…"
                : "Sign in with JAW"}
            </button>
            {!auth.jawConfigured && (
              <p className="fine" role="status">
                JAW account sign-in is unavailable. Configure the public JAW key
                and backend Sepolia verification.
              </p>
            )}
          </section>
        ) : (
          <>
            {!detail && (
              <section className="welcome" aria-label="New conversation">
                <div className="welcome-mark" aria-hidden="true">
                  ✳
                </div>
                <h1>What can I take off your plate?</h1>
                <p>
                  {auth.root
                    ? "Describe a task to review a scoped agent mandate."
                    : "Your JAW account is connected. Verify your human root before creating an agent."}
                </p>
              </section>
            )}
            {!auth.root && (
              <section className="trust-gate" aria-label="World ID trust gate">
                <span className="eyebrow">One human · one root</span>
                <h2>Verify with World ID</h2>
                <p>
                  Proof of Human establishes your root and unlocks an ENS agent
                  namespace. Your JAW session remains connected if you close
                  verification.
                </p>
                <button
                  disabled={busy}
                  onClick={() =>
                    void perform(async () =>
                      setProof({
                        request: await api<WorldProofRequest>(
                          "/world/root/request",
                          {},
                        ),
                      }),
                    )
                  }
                >
                  {busy ? "Preparing verification…" : "Verify with World ID"}
                </button>
              </section>
            )}
            {detail && (
              <Transcript
                items={transcript}
                busy={busy}
                capabilities={caps}
                setCapabilities={setCaps}
                actions={actions}
                permissionClient={permissionClient}
                onPermissionRecorded={() => select(detail.mission.id)}
              />
            )}
          </>
        )}
      </AppShell>
      {proof && (
        <WorldVerification
          request={proof.request}
          onVerified={async (result) => {
            await api(
              proof.actionId
                ? `/actions/${encodeURIComponent(proof.actionId)}/approval/verify`
                : "/world/root/verify",
              { requestId: proof.request.requestId, proof: result },
            );
            verifiedRequest.current = proof.request.requestId;
          }}
          onSuccess={() => {
            setProof(null);
            void perform(auth.refresh);
          }}
          onClose={() => {
            const pending = proof;
            setProof(null);
            if (
              pending.actionId &&
              verifiedRequest.current !== pending.request.requestId
            )
              void perform(async () =>
                setDetail(
                  await api<MissionDetailResponse>(
                    `/actions/${encodeURIComponent(pending.actionId!)}/approval/cancel`,
                    {},
                  ),
                ),
              );
          }}
          onError={(cause) =>
            setError(`World verification did not complete: ${String(cause)}`)
          }
        />
      )}
    </>
  );
}
const legacyIdentity = new URLSearchParams(location.search).has("identity") || new URLSearchParams(location.search).has("mission") || import.meta.env.MODE === "e2e";
mountApp(document.getElementById("root")!, legacyIdentity ? <App /> : <WorkflowWorkspace />, import.meta.hot?.data ?? {});
