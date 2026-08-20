export const CONFIRM_DISPLAY_MAX = 240;

const ANSI = /\x1B\[[0-9;]*[A-Za-z]/g;
const C0_C1 = /[\u0000-\u001F\u007F-\u009F]/g;

export function sanitizeConfirmLine(value: string, max = CONFIRM_DISPLAY_MAX): string {
  const single = value.replace(ANSI, "").replace(C0_C1, " ").replace(/\s+/g, " ").trim();
  if (single.length <= max) {
    return single;
  }
  return single.slice(0, max);
}

export type ApprovalDeps = {
  hasUI: boolean;
  confirm: (title: string, message: string) => Promise<boolean>;
  signal?: AbortSignal;
};

export type ApprovalDecision = { ok: true } | { ok: false; text: string };

export async function approveOrDeny(
  title: string,
  rawSubject: string,
  deps: ApprovalDeps,
): Promise<ApprovalDecision> {
  if (deps.signal?.aborted) {
    return { ok: false, text: "Cancelled" };
  }
  if (!deps.hasUI) {
    return {
      ok: false,
      text: "Denied: print and JSON modes have no UI to confirm this tool.",
    };
  }
  let ok: boolean;
  try {
    ok = await deps.confirm(title, sanitizeConfirmLine(rawSubject));
  } catch {
    return { ok: false, text: "Cancelled" };
  }
  if (deps.signal?.aborted) {
    return { ok: false, text: "Cancelled" };
  }
  if (!ok) {
    return { ok: false, text: "User Rejected" };
  }
  return { ok: true };
}
