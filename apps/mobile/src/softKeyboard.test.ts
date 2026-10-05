import { describe, expect, it } from "vitest";
import { KEYBOARD_SENTINEL, diffSoftKeyboardText } from "./softKeyboard";

const S = KEYBOARD_SENTINEL;

describe("diffSoftKeyboardText", () => {
  it("types appended characters", () => {
    expect(diffSoftKeyboardText(S, `${S}h`)).toEqual({ backspaces: 0, text: "h", next: `${S}h` });
    expect(diffSoftKeyboardText(`${S}h`, `${S}hi`).text).toBe("i");
  });

  it("sends Backspace for deletions, even past everything typed", () => {
    expect(diffSoftKeyboardText(`${S}hi`, `${S}h`)).toMatchObject({ backspaces: 1, text: "" });
    // Deleting into the sentinel still counts, and the field resets.
    const edit = diffSoftKeyboardText(S, S.slice(1));
    expect(edit).toEqual({ backspaces: 1, text: "", next: S });
  });

  it("replays autocorrect as backspace-then-retype", () => {
    expect(diffSoftKeyboardText(`${S}teh `, `${S}the `)).toMatchObject({ backspaces: 3, text: "he " });
  });

  it("handles the double-space full stop", () => {
    expect(diffSoftKeyboardText(`${S}hello `, `${S}hello. `)).toMatchObject({ backspaces: 1, text: ". " });
  });

  it("counts emoji as one character and never splits them", () => {
    expect(diffSoftKeyboardText(`${S}a😀`, `${S}a`)).toMatchObject({ backspaces: 1, text: "" });
    expect(diffSoftKeyboardText(`${S}😀`, `${S}😃`)).toMatchObject({ backspaces: 1, text: "😃" });
  });

  it("resets after Return so the field never grows unbounded", () => {
    expect(diffSoftKeyboardText(`${S}ls`, `${S}ls\n`)).toEqual({ backspaces: 0, text: "\n", next: S });
  });

  it("resets long input only at a word boundary", () => {
    const long = `${S}${"word ".repeat(10)}`;
    expect(diffSoftKeyboardText(long, `${long}x`).next).toBe(`${long}x`);
    expect(diffSoftKeyboardText(`${long}x`, `${long}x `).next).toBe(S);
  });
});
