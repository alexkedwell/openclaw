import { describe, expect, it } from "vitest";
import { readQuestionResourceInput, readQuestionResourcePreview } from "./question-media.js";

describe("question resource parsing", () => {
  it("keeps validated file filters and strips unrelated input fields", () => {
    expect(
      readQuestionResourceInput({
        selection: "explicit",
        viewId: "files",
        userOptions: { kind: "file", accept: ["image/*", ".pdf"], ignored: true },
        ignored: true,
      }),
    ).toEqual({
      selection: "explicit",
      viewId: "files",
      userOptions: { kind: "file", accept: ["image/*", ".pdf"] },
    });
    expect(readQuestionResourceInput({ selection: "implicit" })).toEqual({
      selection: "implicit",
    });
  });

  it.each([
    { selection: "explicit", userOptions: { kind: "file", accept: ["image/*", 1] } },
    { selection: "explicit", viewId: 1 },
  ])("rejects malformed optional input fields: %j", (input) => {
    expect(readQuestionResourceInput(input)).toBeUndefined();
  });

  it("retains optional MCP arguments only after object validation", () => {
    const preview = { type: "mcp_app_tool", name: "preview_file" };
    expect(readQuestionResourcePreview({ ...preview, arguments: { page: 1 } })).toEqual({
      ...preview,
      arguments: { page: 1 },
    });
    expect(readQuestionResourcePreview(preview)).toEqual(preview);
    expect(readQuestionResourcePreview({ ...preview, arguments: [1] })).toBeUndefined();
  });
});
