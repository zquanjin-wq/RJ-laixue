const TRANSIENT_GATEWAY_STATUSES = new Set([502, 503, 504]);

/** Retry only explicit gateway failures. Callers may safely use this for
 * idempotent probes and asset confirmation without replaying unknown writes. */
export async function fetchWithGatewayRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
  maxAttempts = 5,
): Promise<Response> {
  let response: Response | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    response = await fetch(input, init);
    if (!TRANSIENT_GATEWAY_STATUSES.has(response.status) || attempt === maxAttempts) {
      return response;
    }
    const delayMs = process.env.NODE_ENV === 'test' ? 0 : Math.min(8_000, 500 * 2 ** (attempt - 1));
    if (delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  }
  return response!;
}
