import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, withDefaults } from "../src/settings";

describe("settings migration", () => {
  it("new installs have auto-lock off", () => {
    expect(DEFAULT_SETTINGS.autoLockMinutes).toBe(0);
    expect(withDefaults(null).settings.autoLockMinutes).toBe(0);
  });

  it("turns off auto-lock for data still on the old 15-minute default", () => {
    const data = withDefaults({ settings: { ...DEFAULT_SETTINGS, autoLockMinutes: 15 } });
    expect(data.settings.autoLockMinutes).toBe(0);
    expect(data.settingsRevision).toBe(1);
  });

  it("keeps a value the user chose", () => {
    expect(withDefaults({ settings: { ...DEFAULT_SETTINGS, autoLockMinutes: 30 } }).settings.autoLockMinutes).toBe(30);
  });

  it("runs only once: 15 chosen after the migration is kept", () => {
    const data = withDefaults({ settings: { ...DEFAULT_SETTINGS, autoLockMinutes: 15 }, settingsRevision: 1 });
    expect(data.settings.autoLockMinutes).toBe(15);
  });
});
