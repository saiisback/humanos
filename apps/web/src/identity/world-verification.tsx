import {
  IDKitRequestWidget,
  proofOfHuman,
  type RpContext,
} from "@worldcoin/idkit";
import type { WorldProofRequest } from "@humanos/schemas";

export function WorldVerification({
  request,
  onVerified,
  onSuccess,
  onClose,
  onError,
}: {
  request: WorldProofRequest;
  onVerified: (proof: unknown) => Promise<void>;
  onSuccess: () => void;
  onClose: () => void;
  onError: (error: unknown) => void;
}) {
  if (import.meta.env.MODE === "e2e")
    return (
      <dialog open aria-label="Synthetic World verification">
        <p>Browser test only: synthetic Proof of Human result.</p>
        <button
          onClick={() => {
            void onVerified({ synthetic: true }).then(onSuccess, onError);
          }}
        >
          Complete synthetic verification
        </button>
        <button onClick={onClose}>Cancel synthetic verification</button>
      </dialog>
    );
  return (
    <IDKitRequestWidget
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      app_id={request.appId as `app_${string}`}
      action={request.action}
      rp_context={request.rpContext as unknown as RpContext}
      environment={request.environment}
      allow_legacy_proofs={false}
      preset={proofOfHuman({ signal: request.signal })}
      handleVerify={onVerified}
      onSuccess={onSuccess}
      onError={onError}
    />
  );
}
