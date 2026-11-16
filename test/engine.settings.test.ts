import { describe, expect, it } from "vitest";
import { FakeDrive } from "../src/testing/fakeDrive";
import { device, saveSettings } from "./kit";

describe("settings", () => {
  it("device-local settings never leave the device or get overwritten", async () => {
    const drive = new FakeDrive();
    const a = device(drive);
    await a.site.settings.save({ zoom: 100, device: "a-only" });
    await a.engine.connect({ interactive: true });
    await saveSettings(a, { zoom: 321 });
    await a.engine.syncNow();

    const file = drive.tagged("settings")[0];
    const json = JSON.parse(drive.readText(file.id));
    expect(json.settings).toEqual({ zoom: 321 });
    expect("device" in json.settings).toBe(false);
    expect(file.name).toBe("settings.json");
    expect(file.parents).toEqual([drive.tagged("folder", "hidden")[0].id]);

    const b = device(drive);
    await b.site.settings.save({ zoom: 1, device: "b-only" });
    await b.engine.connect({ interactive: true });
    expect(b.site.settings.value).toEqual({ zoom: 321, device: "b-only" });

    await saveSettings(a, { zoom: 400 });
    await a.engine.syncNow();
    await b.engine.pull();
    expect(b.site.settings.value).toEqual({ zoom: 400, device: "b-only" });
    expect(a.site.settings.value.device).toBe("a-only");
  });

  it("a change to only device-local settings does not touch Drive", async () => {
    const drive = new FakeDrive();
    const a = device(drive);
    await a.engine.connect({ interactive: true });
    const before = drive.tagged("settings")[0].version;
    const writes = drive.writeCount;
    await saveSettings(a, { device: "changed" });
    await a.engine.syncNow();
    expect(drive.tagged("settings")[0].version).toBe(before);
    expect(drive.writeCount).toBe(writes);
  });

  it("the newest updatedAt wins when both changed", async () => {
    const drive = new FakeDrive();
    const a = device(drive);
    await a.engine.connect({ interactive: true });
    const b = device(drive);
    await b.engine.connect({ interactive: true });

    await saveSettings(a, { zoom: 500 }); // older
    await saveSettings(b, { zoom: 600 }); // newer
    await b.engine.syncNow();
    await a.engine.syncNow();
    expect(a.site.settings.value.zoom).toBe(600);

    await saveSettings(b, { zoom: 650 }); // older
    await saveSettings(a, { zoom: 700 }); // newer
    await b.engine.syncNow();
    await a.engine.syncNow();
    await b.engine.syncNow();
    expect(a.site.settings.value.zoom).toBe(700);
    expect(b.site.settings.value.zoom).toBe(700);
  });
});
