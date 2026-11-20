/*
Resolve and create the stable per-user directory an application uses for configuration.
*/

import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { InputError } from "./leaf-inputs.ts";

/** A portable single path segment used to identify an application's config directory. */
const APP_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Reports whether a value is an absolute POSIX path without an embedded NUL. */
function isAbsolutePosixPath(value: string): boolean {
  return !value.includes("\0") && posix.isAbsolute(value);
}

/** Reports whether a Windows path has a drive root or a fully qualified UNC root. */
function isQualifiedWindowsPath(value: string): boolean {
  if (value.includes("\0") || !win32.isAbsolute(value)) {
    return false;
  }
  const root = win32.parse(value).root;
  return /^[A-Za-z]:[\\/]$/.test(root) || /^[/\\]{2}[^/\\]+[/\\][^/\\]+[/\\]?$/.test(root);
}

/**
 * Selects a normalized per-user config directory without reading or changing the filesystem.
 */
export function selectConfigDir(options: {
  /** Application identity appended as one safe path segment. */
  appKey: string;
  /** Complete application directory that overrides platform defaults. */
  override?: string;
  /** Operating system whose native path rules should be used. */
  platform: NodeJS.Platform;
  /** Environment values used for platform-specific defaults. */
  env: NodeJS.ProcessEnv;
  /** Current user's home directory used when the platform requires it. */
  home: string;
}): string {
  const { appKey, override, platform, env, home } = options;
  if (!APP_KEY_PATTERN.test(appKey) || appKey.includes("\0")) {
    throw new InputError("Invalid app key: expected a single safe path segment.");
  }

  if (platform !== "linux" && platform !== "darwin" && platform !== "win32") {
    throw new InputError("Unsupported platform: config directory defaults are unavailable.");
  }

  if (override !== undefined) {
    const valid = platform === "win32" ? isQualifiedWindowsPath(override) : isAbsolutePosixPath(override);
    if (!valid) {
      throw new InputError("Invalid config directory override: expected an absolute path.");
    }
    return platform === "win32" ? win32.normalize(override) : posix.normalize(override);
  }

  if (platform === "win32") {
    const appData = env.APPDATA;
    if (appData === undefined || !isQualifiedWindowsPath(appData)) {
      throw new InputError("Invalid APPDATA: expected an absolute drive-rooted or UNC path.");
    }
    return win32.normalize(win32.join(appData, appKey));
  }

  let base: string;
  if (platform === "linux" && env.XDG_CONFIG_HOME !== undefined && isAbsolutePosixPath(env.XDG_CONFIG_HOME)) {
    base = env.XDG_CONFIG_HOME;
  } else {
    if (!isAbsolutePosixPath(home)) {
      throw new InputError("Invalid home directory: expected an absolute path.");
    }
    base = posix.join(home, platform === "darwin" ? "Library/Application Support" : ".config");
  }
  return posix.normalize(posix.join(base, appKey));
}

/**
 * Resolves the app config directory for the current process and creates it recursively.
 */
export async function resolveConfigDir(appKey: string, override?: string): Promise<string> {
  const directory = selectConfigDir({
    appKey,
    override,
    platform: process.platform,
    env: process.env,
    home: homedir(),
  });
  await mkdir(directory, { recursive: true });
  return directory;
}
