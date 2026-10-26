import { describe, expect, it, vi } from "vitest";
import { lazySection } from "../src/ui/lazySection";

// Mock minimal DOM element for testing lazySection
function mockEl(tag = "div"): any {
  const children: any[] = [];
  const listeners: Record<string, Function[]> = {};
  const el: any = {
    tag,
    open: false,
    children,
    createEl(childTag: string, opts?: any) {
      const child = mockEl(childTag);
      if (opts?.cls) child.cls = opts.cls;
      children.push(child);
      return child;
    },
    createDiv(opts?: any) {
      return el.createEl("div", opts);
    },
    createSpan(opts?: any) {
      return el.createEl("span", opts);
    },
    addEventListener(evt: string, cb: Function) {
      (listeners[evt] ??= []).push(cb);
    },
    dispatchEvent(evtName: string) {
      for (const cb of listeners[evtName] ?? []) cb();
    },
  };
  return el;
}

vi.mock("obsidian", () => ({
  setIcon: () => {},
}));

describe("lazySection", () => {
  it("when closed, does not call renderBody immediately", () => {
    const parent = mockEl("div");
    let called = false;
    const body = lazySection(parent, "Test Title", false, () => {}, () => {
      called = true;
    });

    expect(called).toBe(false);
    expect(body.children.length).toBe(0);
  });

  it("when opened, calls renderBody exactly once", () => {
    const parent = mockEl("div");
    let callCount = 0;
    const onToggle = vi.fn();
    const renderBody = vi.fn((bodyEl: any) => {
      callCount++;
      bodyEl.createDiv({ text: "Content" });
    });

    const body = lazySection(parent, "Test Title", false, onToggle, renderBody);
    const details = parent.children[0];

    expect(callCount).toBe(0);

    // User opens details
    details.open = true;
    details.dispatchEvent("toggle");

    expect(onToggle).toHaveBeenCalledWith(true);
    expect(callCount).toBe(1);
    expect(body.children.length).toBe(1);

    // User toggles again (close and open)
    details.open = false;
    details.dispatchEvent("toggle");
    expect(callCount).toBe(1);

    details.open = true;
    details.dispatchEvent("toggle");
    expect(callCount).toBe(1); // not called again
  });

  it("when initialized open, calls renderBody immediately", () => {
    const parent = mockEl("div");
    let called = false;
    lazySection(parent, "Test Title", true, () => {}, () => {
      called = true;
    });

    expect(called).toBe(true);
  });
});
