// http.ts — the small shared types the API surfaces pass around, and the JSON helpers.
//
// A handler receives an ApiRequest (already read off the wire) and returns an ApiResponse.
// app.ts is the only module that talks to node:http directly; the surfaces stay pure.

export interface ApiRequest {
  method: string;
  /** The path split into decoded segments, without any leading or trailing empty part. */
  segments: string[];
  query: URLSearchParams;
  headers: Record<string, string>;
  body: Buffer;
}

export interface ApiResponse {
  status: number;
  /** A JSON value to serialise, or a Buffer to send as-is. */
  body: unknown;
  contentType?: string;
  headers?: Record<string, string>;
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): ApiResponse {
  return { status, body, contentType: 'application/json; charset=utf-8', headers };
}

export function notFound(message = 'Not Found'): ApiResponse {
  return json(404, { message });
}

export function unauthorized(): ApiResponse {
  return json(401, { message: 'Requires authentication' });
}

/** The bearer token on the request, or null when there is none. */
export function bearerToken(req: ApiRequest): string | null {
  const header = req.headers['authorization'] ?? '';
  const match = /^Bearer\s+(.+)$/.exec(header.trim());
  return match ? match[1]!.trim() : null;
}

/**
 * Parse the request body as JSON. Returns `{ ok: true, value }`, or `{ ok: false }` when the
 * body is empty or is not valid JSON. An empty body is a missing body, not an error by itself.
 */
export function parseJsonBody(req: ApiRequest): { ok: true; value: unknown } | { ok: false; empty: boolean } {
  const text = req.body.toString('utf8').trim();
  if (text === '') return { ok: false, empty: true };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, empty: false };
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}
