/**
 * A wait between a loop's rounds that ends early when the worker is stopping,
 * so a restart doesn't sit out an hour-long interval (and the service manager's
 * stop timeout) before the worker exits.
 */
export function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}
