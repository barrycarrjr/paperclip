import { describe, expect, it } from "vitest";
import { actionFailureText, failureDetail, inlineFailureText } from "./actionFailure";

describe("email action failure wording", () => {
  it("keeps what the server said, which is the only useful part", () => {
    const err = new Error("Mail command failed: 550 5.0.0 Sender is not allowed to send");

    expect(actionFailureText("Forward", err)).toBe(
      "Forward failed: Mail command failed: 550 5.0.0 Sender is not allowed to send",
    );
    expect(inlineFailureText(err)).toBe(
      "Mail command failed: 550 5.0.0 Sender is not allowed to send",
    );
  });

  it("names the action when the rejection carried no text", () => {
    expect(actionFailureText("Reply", new Error("   "))).toBe("Reply failed");
    expect(actionFailureText("Delete", undefined)).toBe("Delete failed");
  });

  it("still says something inline when there is nothing to quote", () => {
    // Silence is the bug being fixed here, so an empty rejection must not
    // produce an empty notice.
    expect(inlineFailureText(new Error(""))).toBe("That did not go through. Try again.");
    expect(inlineFailureText(null)).toBe("That did not go through. Try again.");
  });

  it("reads a plain string rejection as well as an Error", () => {
    expect(failureDetail("smtp refused")).toBe("smtp refused");
    expect(failureDetail({ nope: true })).toBe("");
  });
});
