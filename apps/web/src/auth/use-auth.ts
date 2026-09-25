import { useEffect, useSyncExternalStore } from "react";
import type {
  AuthSessionResponse,
  CreateSiweChallengeResponse,
} from "@humanos/schemas";
import { api } from "../../lib/api";
import {
  createBrowserJawAuthClient,
  JawAuthError,
  type JawAuthClient,
} from "./jaw";

export type AuthStatus =
  | "loading"
  | "signed-out"
  | "signing-in"
  | "signed-in"
  | "signing-out";
export type AuthState = AuthSessionResponse & { status: AuthStatus };
type AuthApi = (path: string, body?: unknown) => Promise<unknown>;

export function createAuthStore(
  jaw: JawAuthClient | null,
  request: AuthApi = api,
) {
  let state: AuthState = {
    status: "loading",
    account: null,
    root: null,
    jawConfigured: false,
  };
  let revision = 0;
  let signInPromise: Promise<void> | null = null;
  let signOutPromise: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  const set = (next: Partial<AuthState>) => {
    state = { ...state, ...next };
    listeners.forEach((listener) => listener());
  };
  async function refresh(): Promise<void> {
    const ticket = revision;
    let session: AuthSessionResponse;
    try {
      session = (await request("/auth/session")) as AuthSessionResponse;
    } catch (error) {
      if (ticket === revision && state.status === "loading")
        set({ status: "signed-out", jawConfigured: false });
      throw error;
    }
    if (ticket !== revision || state.status === "signing-out") return;
    set({ ...session, status: session.account ? "signed-in" : "signed-out" });
  }
  function signIn(): Promise<void> {
    if (signInPromise) return signInPromise;
    if (signOutPromise) return signOutPromise.then(signIn);
    if (!jaw) return Promise.reject(new JawAuthError("UNAVAILABLE"));
    const ticket = ++revision;
    set({ status: "signing-in" });
    signInPromise = (async () => {
      try {
        const challenge = (await request(
          "/auth/siwe/nonce",
          {},
        )) as CreateSiweChallengeResponse;
        const signed = await jaw.connect(challenge);
        await request("/auth/siwe/verify", {
          challengeId: challenge.challengeId,
          ...signed,
        });
        if (ticket === revision) await refresh();
      } catch (error) {
        if (ticket === revision) {
          try {
            await refresh();
          } catch {
            set({ status: state.account ? "signed-in" : "signed-out" });
          }
        }
        throw error;
      } finally {
        signInPromise = null;
      }
    })();
    return signInPromise;
  }
  function signOut(): Promise<void> {
    if (signOutPromise) return signOutPromise;
    ++revision;
    set({ status: "signing-out" });
    signOutPromise = (async () => {
      if (signInPromise) {
        try {
          await signInPromise;
        } catch {
          /* Still revoke any existing session. */
        }
      }
      const [backend] = await Promise.allSettled([
        request("/auth/logout", {}),
        jaw?.disconnect() ?? Promise.resolve(),
      ]);
      if (backend.status === "rejected") {
        set({ status: state.account ? "signed-in" : "signed-out" });
        try {
          await refresh();
        } catch {
          set({ status: state.account ? "signed-in" : "signed-out" });
        }
        throw backend.reason;
      }
      ++revision;
      set({ ...(backend.value as AuthSessionResponse), status: "signed-out" });
    })().finally(() => {
      signOutPromise = null;
    });
    return signOutPromise;
  }
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh,
    signIn,
    signOut,
  };
}

const jaw = createBrowserJawAuthClient(
  import.meta.env.VITE_JAW_API_KEY ?? "",
  import.meta.env.VITE_JAW_APP_LOGO_URL,
);
const auth = createAuthStore(jaw);
let started = false;
export function useAuth() {
  const state = useSyncExternalStore(
    auth.subscribe,
    auth.getSnapshot,
    auth.getSnapshot,
  );
  useEffect(() => {
    if (started) return;
    started = true;
    void auth.refresh().catch(() => {
      // A failed session load is surfaced to the calling UI on retry.
    });
  }, []);
  return {
    ...state,
    signIn: auth.signIn,
    signOut: auth.signOut,
    refresh: auth.refresh,
    jawConfigured: !!jaw && state.jawConfigured,
  };
}
