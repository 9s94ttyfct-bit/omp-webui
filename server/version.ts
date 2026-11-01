import pkg from "../package.json";

/** Set by `bun build --define` for a test build of another version (`scripts/windows-launcher.ts --version`). */
declare const OMPW_BUILD_VERSION: string | undefined;

/**
 * The app's version: package.json's, or the one a test build was compiled with (the Windows updater's tests install a
 * build that says it is a later version).
 */
export const APP_VERSION: string = typeof OMPW_BUILD_VERSION === "string" ? OMPW_BUILD_VERSION : pkg.version;
