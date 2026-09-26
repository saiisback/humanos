export async function loadRunSnapshot<R, O, P>(
  getRun: () => Promise<R>,
  getOutputs: () => Promise<O>,
  getPreview: (run: R) => Promise<P>,
) {
  const pendingRun = getRun();
  const [run, outputs, preview] = await Promise.all([
    pendingRun,
    getOutputs(),
    pendingRun.then(getPreview),
  ]);
  return { run, outputs, preview };
}
