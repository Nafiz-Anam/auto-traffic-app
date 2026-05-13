const fs = require("node:fs");
const path = require("node:path");
const {
    findProjectCapsolverExtensionDir,
    resolveChromiumExtensionDir,
} = require("./extension-loader.js");

function escapeJsString(value) {
    return String(value)
        .replace(/\\/g, "\\\\")
        .replace(/'/g, "\\'")
        .replace(/\r/g, "\\r")
        .replace(/\n/g, "\\n");
}

/**
 * CapSolver reads /assets/config.js on startup when storage has no apiKey.
 * @see CapSolver.Browser.Extension background service worker
 */
function buildCapsolverConfigJs(apiKey) {
    const key = escapeJsString(apiKey.trim());
    return `// Written by Auto Traffic — gitignored. Update via CapSolver tab or data/capsolver-settings.json.
const defaultConfig = {
  apiKey: '${key}',
  useCapsolver: true,
  manualSolving: false,
  enabledForRecaptcha: true,
  enabledForRecaptchaV3: true,
  enabledForImageToText: true,
  enabledForAwsCaptcha: true,
  reCaptchaMode: 'click',
  blackUrlList: [],
};
`;
}

function resolveCapsolverExtensionDir(config = {}) {
    const fromSettings = resolveChromiumExtensionDir(
        config?.chromiumExtensionPath,
    );
    if (fromSettings) {
        return fromSettings;
    }
    return findProjectCapsolverExtensionDir();
}

/**
 * Writes the API key into the unpacked CapSolver extension before Chromium loads it.
 * @returns {{ ok: boolean, path?: string, error?: string }}
 */
function syncCapsolverApiKeyToExtension(apiKey, config = {}) {
    const trimmed = (apiKey || "").trim();
    if (!trimmed) {
        return { ok: false, error: "No CapSolver API key configured" };
    }

    const extDir = resolveCapsolverExtensionDir(config);
    if (!extDir) {
        return {
            ok: false,
            error:
                "CapSolver extension folder not found in project root (expected CapSolver.Browser.Extension* or capsolver*)",
        };
    }

    const assetsDir = path.join(extDir, "assets");
    const configPath = path.join(assetsDir, "config.js");
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(configPath, buildCapsolverConfigJs(trimmed), "utf8");
    console.log(`CapSolver API key synced to ${configPath}`);
    return { ok: true, path: configPath };
}

module.exports = {
    buildCapsolverConfigJs,
    resolveCapsolverExtensionDir,
    syncCapsolverApiKeyToExtension,
};
