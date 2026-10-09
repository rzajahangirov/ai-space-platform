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
  const data = await response.json();
  if (!response.ok) throw new ApiError(data.error ?? 'Request failed.', response.status);
  return data;
}
export const post = <T = any>(path: string, data: unknown) =>
  api<T>(path, { method: 'POST', body: JSON.stringify(data) });
export const patch = <T = any>(path: string, data: unknown) =>
  api<T>(path, { method: 'PATCH', body: JSON.stringify(data) });
