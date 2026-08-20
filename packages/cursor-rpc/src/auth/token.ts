export function isExpiringSoon(jwt: string, nowSeconds = Math.floor(Date.now() / 1000), marginSeconds = 300): boolean {
  try {
    const payloadPart = jwt.split(".")[1];
    if (payloadPart === undefined || payloadPart.length === 0) {
      return true;
    }
    const padded = payloadPart.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (payloadPart.length % 4)) % 4);
    const payload = JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as { exp?: unknown };
    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
      return true;
    }
    return payload.exp - nowSeconds < marginSeconds;
  } catch {
    return true;
  }
}
