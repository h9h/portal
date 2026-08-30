export function portalFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("X-Portal-Data", "1");
  return fetch(input, { ...init, headers });
}
