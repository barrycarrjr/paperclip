const BASE = "/api";

export class ApiError extends Error {
  status: number;
  body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers ?? undefined);
  const body = init?.body;
  if (!(body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const res = await fetch(`${BASE}${path}`, {
    headers,
    credentials: "include",
    ...init,
  });
  if (!res.ok) {
    const errorBody = await res.json().catch(() => null);
    // Most routes answer with `{ error }`, but the plugin bridge answers with
    // `{ code, message }`. Without the second lookup every bridge failure
    // reached the operator as a bare "Request failed: 502".
    const shape = errorBody as { error?: string; message?: string } | null;
    throw new ApiError(
      shape?.error ?? shape?.message ?? `Request failed: ${res.status}`,
      res.status,
      errorBody,
    );
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "POST", body: JSON.stringify(body) }),
  postForm: <T>(path: string, body: FormData) =>
    request<T>(path, { method: "POST", body }),
  /** POST a binary body (Blob/File/ArrayBuffer/Uint8Array) with caller-supplied
   * Content-Type. Used for raw artifact uploads like `.pcplugin` archives.
   * Header keys are normalized to lowercase before merging so a caller passing
   * "Content-Type" and the default "content-type" don't end up duplicated as
   * `application/octet-stream, application/octet-stream` in the outgoing
   * request — which would break server-side type matching. */
  postRaw: <T>(
    path: string,
    body: Blob | ArrayBuffer | Uint8Array,
    headers: Record<string, string> = {},
  ) => {
    const merged: Record<string, string> = { "content-type": "application/octet-stream" };
    for (const [k, v] of Object.entries(headers)) {
      merged[k.toLowerCase()] = v;
    }
    return request<T>(path, {
      method: "POST",
      body: body as BodyInit,
      headers: merged,
    });
  },
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PUT", body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PATCH", body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};
