export type HeartbeatController = {
  stop: () => void;
};

export function startHeartbeat(
  send: () => void,
  options: { intervalMs?: number; setIntervalFn?: typeof setInterval; clearIntervalFn?: typeof clearInterval } = {},
): HeartbeatController {
  const intervalMs = options.intervalMs ?? 5000;
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval;
  const handle = setIntervalFn(() => {
    send();
  }, intervalMs);
  return {
    stop: () => {
      clearIntervalFn(handle);
    },
  };
}

export function startStallTimer(
  onStall: () => void,
  options: { stallMs?: number; setTimeoutFn?: typeof setTimeout; clearTimeoutFn?: typeof clearTimeout } = {},
): { touch: () => void; stop: () => void } {
  const stallMs = options.stallMs ?? 30_000;
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
  let handle: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    if (handle !== undefined) {
      clearTimeoutFn(handle);
    }
    handle = setTimeoutFn(onStall, stallMs);
  };
  arm();
  return {
    touch: arm,
    stop: () => {
      if (handle !== undefined) {
        clearTimeoutFn(handle);
      }
    },
  };
}
