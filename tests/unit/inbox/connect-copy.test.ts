import { describe, expect, it } from "vitest";
import { CONNECT_ERROR_TEXT } from "@/components/email/inbox-copy";
import { CONNECT_ERROR_REASONS } from "@/lib/server/inbox/oauth/connect";

// The callback sends one of CONNECT_ERROR_REASONS back to /settings?inbox=error&reason=…, and the
// screen shows fixed text for each. The screen cannot import the server module, so this keeps the
// two lists the same.
describe("connect failure reasons", () => {
  it("each has its own text on the screen, and the screen knows no others", () => {
    expect([...CONNECT_ERROR_TEXT.keys()].sort()).toEqual([...CONNECT_ERROR_REASONS].sort());
  });
});
