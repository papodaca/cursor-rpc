export function isExpiringSoon(jwt: string, nowSeconds = Math.floor(Date.now() / 1000), marginSeconds = 300): boolean {
  try {
    const payloadPart = jwt.split(".")[1];
    if (payloadPart === undefined || payloadPart.length === 0) {
      return true;
    }
    const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as { exp?: unknown };
    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
      return true;
    }
    return payload.exp - nowSeconds < marginSeconds;
  } catch {
    return true;
  }
}
