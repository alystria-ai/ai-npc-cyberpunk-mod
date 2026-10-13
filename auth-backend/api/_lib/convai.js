// The only two calls this service makes to Convai. The API key goes in a header, never in a log or a response.
function parseExpiry(raw) {
  if (!raw) return null;
  const milliseconds = typeof raw === 'number' ? (raw < 1_000_000_000_000 ? raw * 1000 : raw) : Date.parse(raw);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

export class ConvaiError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConvaiError';
  }
}

export function createConvaiClient({ fetchImpl = fetch, connectUrl, revokeUrl, timeoutMs = 8000, now = Date.now }) {
  return {
    /** POST /user/connect with the key: a token that lives about an hour. */
    async mint(apiKey) {
      let response;
      try {
        response = await fetchImpl(connectUrl, {
          method: 'POST',
          headers: { 'CONVAI-API-KEY': apiKey, 'Content-Type': 'application/json' },
          body: '{}',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw new ConvaiError('Convai Connect unreachable');
      }
      if (!response.ok) throw new ConvaiError(`Convai Connect responded ${response.status}`);
      let data;
      try {
        data = await response.json();
      } catch {
        throw new ConvaiError('Convai Connect returned no JSON');
      }
      const token = data?.apiAuthToken ?? data?.api_auth_token;
      if (typeof token !== 'string' || !token.trim()) throw new ConvaiError('Convai Connect returned no apiAuthToken');
      const expiresAtMs = parseExpiry(data.expirationTime ?? data.expiration_time) ?? now() + 60 * 60 * 1000;
      return { token: token.trim(), expiresAtMs };
    },
    /**
     * POST /user/revoke-token. Best effort: true when Convai accepted it. A session already running is NOT ended
     * by a revoke (Convai's documentation); it only stops the token being used for new connections.
     */
    async revoke(apiKey, token) {
      try {
        const response = await fetchImpl(revokeUrl, {
          method: 'POST',
          headers: { 'CONVAI-API-KEY': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiAuthToken: token }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        try { await response.body?.cancel(); } catch { /* already closed */ }
        return response.ok;
      } catch {
        return false;
      }
    },
  };
}
