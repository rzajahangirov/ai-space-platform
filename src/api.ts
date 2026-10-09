export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    credentials: 'same-origin',
    headers: {
      // A JSON content type without a body is rejected by the server (e.g. DELETE).
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      'X-AgentSpace-Request': '1',
      ...options.headers,
    },
  });
  // A proxy or host error page (HTML/plain text) must surface as a readable error, not a JSON SyntaxError.
  const data = response.headers.get('content-type')?.includes('application/json')
    ? await response.json()
    : null;
  if (!response.ok)
    throw new ApiError(
      data?.error ??
        (response.status >= 500 || response.status === 404
          ? 'The server is unavailable. Please try again in a minute.'
          : 'Request failed.'),
      response.status,
    );
  if (data === null)
    throw new ApiError('The server returned an unexpected response.', response.status);
  return data;
}
export const post = <T = any>(path: string, data: unknown) =>
  api<T>(path, { method: 'POST', body: JSON.stringify(data) });
export const patch = <T = any>(path: string, data: unknown) =>
  api<T>(path, { method: 'PATCH', body: JSON.stringify(data) });

let liveOrigin: Promise<string | null> | undefined;
/**
 * WebSocket URL for a project's live channel. Same-origin deployments use the session cookie;
 * when the API runs on another origin, a single-use ticket replaces the cookie.
 */
export async function liveUrl(projectId: string) {
  const path = `/api/projects/${encodeURIComponent(projectId)}/live`;
  liveOrigin ??= api<{ liveOrigin?: string | null }>('/auth/config').then(
    (c) => c.liveOrigin ?? null,
    (e) => {
      liveOrigin = undefined;
      throw e;
    },
  );
  const origin = await liveOrigin;
  if (!origin) return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}`;
  const { ticket } = await post<{ ticket: string }>('/live-ticket', {});
  return `${origin.replace(/^http/, 'ws')}${path}?ticket=${encodeURIComponent(ticket)}`;
}
