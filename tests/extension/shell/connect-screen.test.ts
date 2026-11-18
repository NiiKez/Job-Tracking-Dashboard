// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectScreen } from "../../../extension/src/popup/connect-screen";
import { AnnounceContext } from "../../../extension/src/popup/ui";

// The popup's Connect screen (extension/src/popup/connect-screen.tsx) in happy-dom: what it says
// aloud when it opens with a notice, and that Connect, clicked again while Chrome is still asked,
// sends nothing more.

const ORIGIN = "https://tracker.example.com";
const NOTICE = "This browser was disconnected. Connect again.";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLElement;
const announce = vi.fn();
const sendMessage = vi.fn();
const request = vi.fn();

beforeEach(() => {
  announce.mockReset();
  sendMessage.mockReset();
  request.mockReset();
  vi.stubGlobal("chrome", {
    runtime: { sendMessage },
    permissions: { request },
    storage: { onChanged: { addListener: vi.fn(), removeListener: vi.fn() } },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function render(notice: string | null) {
  act(() =>
    root.render(
      createElement(
        AnnounceContext,
        { value: announce },
        createElement(ConnectScreen, { suggested: ORIGIN, notice, onConnected: () => {} }),
      ),
    ),
  );
}

const button = () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
const submit = () =>
  act(() => {
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });

/** A promise and the function that settles it, for an answer that comes later. */
function later<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("the Connect screen", () => {
  it("says the notice aloud when it opens with one", () => {
    render(NOTICE);
    expect(container.textContent).toContain(NOTICE);
    expect(announce).toHaveBeenCalledWith(NOTICE);
  });

  it("says nothing when it opens without one", () => {
    render(null);
    expect(announce).not.toHaveBeenCalled();
  });

  it("sends one Connect while Chrome is asked, and takes the next click once that is answered", async () => {
    const granted = later<boolean>();
    const reply = later<unknown>();
    request.mockReturnValueOnce(granted.promise);
    sendMessage.mockReturnValueOnce(reply.promise);
    render(null);

    submit();
    expect(button().getAttribute("aria-disabled")).toBe("true");
    expect(container.textContent).toContain("Connecting to tracker.example.com");
    submit(); // a double click, or Enter pressed again
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);

    await act(async () => {
      granted.resolve(true);
      reply.resolve({ ok: true });
    });
    expect(button().getAttribute("aria-disabled")).toBeNull();
    expect(container.textContent).toContain("Confirm on tracker.example.com in the tab that opened.");

    // Connect again on purpose (the tab was closed, say): it starts over.
    request.mockResolvedValueOnce(true);
    sendMessage.mockResolvedValueOnce({ ok: true });
    submit();
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });
});
