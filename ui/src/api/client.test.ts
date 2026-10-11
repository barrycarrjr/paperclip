import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "./client";

function reply(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

/** A reply whose body is not JSON, such as a proxy's error page. */
function pageReply(status: number) {
  return {
    ok: false,
    status,
    json: async () => {
      throw new SyntaxError("Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON");
    },
  } as unknown as Response;
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function failureOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as ApiError;
  }
  throw new Error("expected the request to fail");
}

describe("api client: what a person is told when a request fails", () => {
  it("keeps the server's words, adds its advice, and keeps the code for code that needs it", async () => {
    fetchMock.mockResolvedValue(reply(403, {
      error: "Only an instance admin can import skills from folders on this computer.",
      code: "skill_local_import_admin_required",
      details: {
        code: "skill_local_import_admin_required",
        remediation: "Import from a URL, GitHub or skills.sh instead, or ask an instance admin.",
      },
    }));

    const error = await failureOf(api.post("/companies/c1/skills/import", { source: "C:/skills" }));

    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(403);
    expect(error.message).toBe(
      "Only an instance admin can import skills from folders on this computer. "
        + "Import from a URL, GitHub or skills.sh instead, or ask an instance admin.",
    );
    expect(error.body.code).toBe("skill_local_import_admin_required");
  });

  it("words a reply that carries only a code, where it said Request failed: 422", async () => {
    fetchMock.mockResolvedValue(reply(422, {
      code: "stage_env_name_protected",
      details: { code: "stage_env_name_protected", names: ["ANTHROPIC_BASE_URL", "PAPERCLIP_API_KEY"] },
    }));

    const error = await failureOf(api.put("/pipelines/p1/stages/s1/automation-env", { env: {} }));

    expect(error.message).toBe("These names cannot be set for a stage: ANTHROPIC_BASE_URL, PAPERCLIP_API_KEY.");
    expect(error.message).not.toContain("422");
  });

  it("words a code sent in place of words, where it showed the code", async () => {
    fetchMock.mockResolvedValue(reply(403, { error: "skill_file_boundary_denied" }));

    const error = await failureOf(api.get("/companies/c1/skills/s1/files?path=../x"));

    expect(error.message).toBe("Skill file paths must stay inside the skill folder.");
  });

  it("words a validation failure sent as JSON, where it showed the JSON", async () => {
    const problems = [
      { code: "too_big", maximum: 4000, type: "string", inclusive: true, exact: false, message: "String must contain at most 4000 character(s)", path: ["intent"] },
    ];
    fetchMock.mockResolvedValue(reply(400, { error: JSON.stringify(problems, null, 2) }));

    const error = await failureOf(api.post("/companies/c1/portfolio-directives/preview", { intent: "x" }));

    expect(error.message).toBe("Some details are not valid. intent: String must contain at most 4000 character(s).");
  });

  it("says something went wrong on the server, where it said Internal server error", async () => {
    fetchMock.mockResolvedValue(reply(500, { error: "Internal server error" }));

    const error = await failureOf(api.get("/companies/c1/skills"));

    expect(error.message).toBe("Something went wrong on the server. Try again in a moment.");
  });

  it("words a reply with no readable body by its status, where it said Request failed: 502", async () => {
    fetchMock.mockResolvedValue(pageReply(502));

    const error = await failureOf(api.get("/companies/c1/skills"));

    expect(error.status).toBe(502);
    expect(error.message).toBe("A service Paperclip depends on did not answer. Try again in a moment.");
  });

  it("says Paperclip could not be reached when no answer comes back, where it said Failed to fetch", async () => {
    const browserError = new TypeError("Failed to fetch");
    fetchMock.mockRejectedValue(browserError);

    const error = await failureOf(api.get("/companies/c1/skills"));

    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(0);
    expect(error.message).toBe("Could not reach Paperclip. Check your connection and try again.");
    expect(error.cause).toBe(browserError);
  });

  it("passes a cancelled request on as it is", async () => {
    const abort = new DOMException("The operation was aborted.", "AbortError");
    fetchMock.mockRejectedValue(abort);

    await expect(api.get("/companies/c1/skills")).rejects.toBe(abort);
  });
});
