/*
Tests platform selection and filesystem creation for per-user application config directories.
*/

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { describe, test } from "node:test";
import { resolveConfigDir, selectConfigDir } from "./config-dir.ts";
import { InputError } from "./leaf-inputs.ts";

/** Asserts that a selector call fails with the exact stable InputError contract. */
function assertInputError(action: () => unknown, message: string): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof InputError);
    assert.equal(error.name, "InputError");
    assert.equal(error.message, message);
    return true;
  });
}

/** Tests platform-specific config directory selection. */
describe("selectConfigDir", () => {
  test("selects normalized Linux XDG and fallback directories", () => {
    assert.equal(
      selectConfigDir({
        appKey: "demo",
        platform: "linux",
        env: { XDG_CONFIG_HOME: "/xdg/./root/../root" },
        home: "/home/demo",
      }),
      "/xdg/root/demo",
    );

    for (const xdg of [undefined, "", "relative", "/bad\0path"]) {
      assert.equal(
        selectConfigDir({
          appKey: "demo",
          platform: "linux",
          env: { XDG_CONFIG_HOME: xdg, APPDATA: "C:\\ignored" },
          home: "/home/demo",
        }),
        "/home/demo/.config/demo",
      );
    }
  });

  test("selects macOS Application Support and ignores XDG", () => {
    assert.equal(
      selectConfigDir({
        appKey: "demo",
        platform: "darwin",
        env: { XDG_CONFIG_HOME: "/ignored" },
        home: "/Users/demo",
      }),
      "/Users/demo/Library/Application Support/demo",
    );
  });

  test("selects qualified drive and UNC APPDATA paths on Windows and ignores XDG", () => {
    assert.equal(
      selectConfigDir({
        appKey: "demo",
        platform: "win32",
        env: { APPDATA: "C:\\Users\\demo\\AppData\\Roaming", XDG_CONFIG_HOME: "/ignored" },
        home: "ignored",
      }),
      "C:\\Users\\demo\\AppData\\Roaming\\demo",
    );
    assert.equal(
      selectConfigDir({
        appKey: "demo",
        platform: "win32",
        env: { APPDATA: "\\\\server\\share\\Roaming" },
        home: "ignored",
      }),
      "\\\\server\\share\\Roaming\\demo",
    );
  });

  test("gives a valid override precedence over invalid defaults", () => {
    assert.equal(
      selectConfigDir({
        appKey: "demo",
        override: "/override/./demo/../config",
        platform: "linux",
        env: { XDG_CONFIG_HOME: "relative" },
        home: "relative",
      }),
      "/override/config",
    );
    assert.equal(
      selectConfigDir({
        appKey: "demo",
        override: "C:\\override\\demo\\..\\config",
        platform: "win32",
        env: {},
        home: "",
      }),
      "C:\\override\\config",
    );
  });

  test("accepts only one safe ASCII app-key segment", () => {
    for (const appKey of ["demo", "Demo2", "0-demo", "com.example.app", "a_b-c", "a.."]) {
      assert.equal(
        selectConfigDir({ appKey, override: "/config/demo", platform: "linux", env: {}, home: "/home/demo" }),
        "/config/demo",
      );
    }

    for (const appKey of [
      "",
      ".",
      "..",
      ".hidden",
      "-demo",
      "_demo",
      "../demo",
      "a/b",
      "a\\b",
      "a\0b",
      "demo app",
      "demo:prod",
      "café",
    ]) {
      assertInputError(
        () => selectConfigDir({ appKey, override: "relative", platform: "linux", env: {}, home: "relative" }),
        "Invalid app key: expected a single safe path segment.",
      );
    }
  });

  test("rejects invalid POSIX and Windows overrides", () => {
    for (const override of ["", "   ", "relative", "\0", "/bad\0path"]) {
      assertInputError(
        () =>
          selectConfigDir({
            appKey: "demo",
            override,
            platform: "linux",
            env: {},
            home: "/home/demo",
          }),
        "Invalid config directory override: expected an absolute path.",
      );
    }

    for (const override of ["", "   ", "relative", "\0", "C:demo", "\\demo", "/root"]) {
      assertInputError(
        () =>
          selectConfigDir({
            appKey: "demo",
            override,
            platform: "win32",
            env: {},
            home: "C:\\Users\\demo",
          }),
        "Invalid config directory override: expected an absolute path.",
      );
    }
  });

  test("rejects invalid platform defaults with field-specific errors", () => {
    for (const appData of [undefined, "", "relative", "C:demo", "\\demo", "/root", "\\bad\0path"]) {
      assertInputError(
        () => selectConfigDir({ appKey: "demo", platform: "win32", env: { APPDATA: appData }, home: "ignored" }),
        "Invalid APPDATA: expected an absolute drive-rooted or UNC path.",
      );
    }

    for (const home of ["", "relative", "/bad\0path"]) {
      assertInputError(
        () =>
          selectConfigDir({
            appKey: "demo",
            platform: "darwin",
            env: { XDG_CONFIG_HOME: "/ignored" },
            home,
          }),
        "Invalid home directory: expected an absolute path.",
      );
    }

    for (const home of ["", "relative", "/bad\0path"]) {
      assertInputError(
        () => selectConfigDir({ appKey: "demo", platform: "linux", env: {}, home }),
        "Invalid home directory: expected an absolute path.",
      );
    }

    assertInputError(
      () => selectConfigDir({ appKey: "demo", platform: "freebsd", env: {}, home: "/home/demo" }),
      "Unsupported platform: config directory defaults are unavailable.",
    );
  });
});

/** Tests recursive creation and unchanged native filesystem failures. */
describe("resolveConfigDir", () => {
  test("creates a nested normalized directory once and reuses it", async () => {
    const work = mkdtempSync(join(tmpdir(), "argsbarg-config-dir-"));
    try {
      const override = join(work, "parent", "nested", "..", "demo");
      const expected = normalize(override);
      assert.equal(existsSync(expected), false);

      assert.equal(await resolveConfigDir("demo", override), expected);
      assert.equal(statSync(expected).isDirectory(), true);
      assert.equal(await resolveConfigDir("demo", override), expected);
      assert.equal(statSync(expected).isDirectory(), true);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("propagates the native error when the target is an existing file", async () => {
    const work = mkdtempSync(join(tmpdir(), "argsbarg-config-file-"));
    try {
      const target = join(work, "existing");
      writeFileSync(target, "occupied");

      await assert.rejects(resolveConfigDir("demo", target), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(!(error instanceof InputError));
        assert.equal((error as NodeJS.ErrnoException).code, "EEXIST");
        assert.equal((error as NodeJS.ErrnoException).path, target);
        return true;
      });
      assert.equal(statSync(target).isFile(), true);
      assert.equal(existsSync(join(work, "demo")), false);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
