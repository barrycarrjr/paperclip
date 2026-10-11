import { failedResponseMessage, isNetworkFailure, NETWORK_FAILURE_MESSAGE } from "../lib/error-message";

const BASE = "/api";

/**
 * A request that failed. The message is a sentence for the person who asked
 * (see lib/error-message), never a bare code or a block of JSON. `body` keeps
 * what the server sent, code and all, for code that has to tell one failure
 * from another. `status` is 0 when no answer came back at all.
 */
export class ApiError extends Error {
  status: number;
  data: unknown;
  body: any;

  constructor(message: string, status: number, data?: unknown, options?: ErrorOptions) {
    super(message, options);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
    this.body = data;
  }
}

/**
 * fetch, except that a request which gets no answer at all (Paperclip is
 * stopped or restarting, or the network dropped) fails with an ApiError that
 * says so. The browser's own error for that, "Failed to fetch", is what
 * people were shown. Anything else fetch throws, a cancel included, is passed
 * on as it is.
 */
export async function fetchOrNetworkError(input: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (error) {
    if (isNetworkFailure(error)) throw new ApiError(NETWORK_FAILURE_MESSAGE, 0, null, { cause: error });
    throw error;
  }
}

/** The ApiError for a response that failed, worded from what the server sent back. */
export async function apiErrorFromResponse(res: Response): Promise<ApiError> {
  const errorBody = await res.json().catch(() => null);
  return new ApiError(failedResponseMessage(res.status, errorBody), res.status, errorBody);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers ?? undefined);
  const body = init?.body;
  if (!(body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const res = await fetchOrNetworkError(`${BASE}${path}`, {
    headers,
    credentials: "include",
    ...init,
  });
  if (!res.ok) {
    // Most routes answer with `{ error }`, the plugin bridge with
    // `{ code, message }`, and some failures carry only a code, JSON or no
    // body at all. Taking `error` or `message` as it came showed people
    // skill_local_import_admin_required or a block of JSON, and a reply with
    // neither reached them as a bare "Request failed: 502".
    throw await apiErrorFromResponse(res);
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
  deleteWithBody: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "DELETE", body: JSON.stringify(body) }),
};
