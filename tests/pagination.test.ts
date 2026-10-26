import { describe, expect, it } from "vitest";
import { paginate } from "../src/ui/pagination";

describe("paginate helper", () => {
  it("paginates array correctly", () => {
    const list = Array.from({ length: 120 }, (_, i) => `item-${i}`);

    const p1 = paginate(list, 1, 50);
    expect(p1.pageItems).toHaveLength(50);
    expect(p1.hasMore).toBe(true);
    expect(p1.total).toBe(120);
    expect(p1.shownCount).toBe(50);

    const p2 = paginate(list, 2, 50);
    expect(p2.pageItems).toHaveLength(100);
    expect(p2.hasMore).toBe(true);
    expect(p2.shownCount).toBe(100);

    const p3 = paginate(list, 3, 50);
    expect(p3.pageItems).toHaveLength(120);
    expect(p3.hasMore).toBe(false);
    expect(p3.shownCount).toBe(120);
  });
});
