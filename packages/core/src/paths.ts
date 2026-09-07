import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";

export interface AppPaths {
  dataDir: string;
  configDir: string;
  cacheDir: string;
  coursesDir: string;
  databasePath: string;
  tokenPath: string;
  pku3bConfigPath: string;
  pku3bCacheDir: string;
}

function defaultDataDir(): string {
  if (platform() === "win32") {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "PKU Study");
  }
  if (platform() === "darwin") {
    return join(homedir(), "Library", "Application Support", "PKU Study");
  }
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "pku-study");
}

function defaultConfigDir(): string {
  if (platform() === "win32") {
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "PKU Study");
  }
  if (platform() === "darwin") {
    return join(homedir(), "Library", "Preferences", "PKU Study");
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "pku-study");
}

function defaultCacheDir(): string {
  if (platform() === "win32") return join(defaultDataDir(), "cache");
  if (platform() === "darwin") return join(homedir(), "Library", "Caches", "PKU Study");
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "pku-study");
}

export function resolveAppPaths(overrides: Partial<AppPaths> = {}): AppPaths {
  const dataDir = resolve(overrides.dataDir ?? process.env.PKU_STUDY_DATA_DIR ?? defaultDataDir());
  const configDir = resolve(
    overrides.configDir ?? process.env.PKU_STUDY_CONFIG_DIR ?? defaultConfigDir(),
  );
  const cacheDir = resolve(
    overrides.cacheDir ?? process.env.PKU_STUDY_CACHE_DIR ?? defaultCacheDir(),
  );
  const coursesDir = resolve(
    overrides.coursesDir ?? process.env.PKU_STUDY_COURSES_DIR ?? join(dataDir, "courses"),
  );

  return {
    dataDir,
    configDir,
    cacheDir,
    coursesDir,
    databasePath: resolve(overrides.databasePath ?? join(dataDir, "state.sqlite")),
    tokenPath: resolve(overrides.tokenPath ?? join(configDir, "api-token")),
    pku3bConfigPath: resolve(overrides.pku3bConfigPath ?? join(configDir, "pku3b", "config.toml")),
    pku3bCacheDir: resolve(overrides.pku3bCacheDir ?? join(cacheDir, "pku3b")),
  };
}
