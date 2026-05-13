const fs = require("node:fs");
const path = require("node:path");
const { CAPSOLVER_SETTINGS_FILE } = require("../data/paths.js");
const { loadCapsolverSettingsData } = require("../data/capsolver.js");
const {
    buildCapsolverConfigJs,
    resolveCapsolverExtensionDir,
    syncCapsolverApiKeyToExtension,
} = require("../automation/capsolver-config-sync.js");

function writeEmptyCapsolverConfig(config) {
    const extDir = resolveCapsolverExtensionDir(config);
    if (!extDir) {
        return;
    }
    const configPath = path.join(extDir, "assets", "config.js");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, buildCapsolverConfigJs(""), "utf8");
}

function register(ipcMain) {
    ipcMain.handle("load-capsolver-settings", async () => {
        return loadCapsolverSettingsData();
    });

    ipcMain.handle("save-capsolver-settings", async (event, settings) => {
        try {
            const apiKey =
                settings && typeof settings.apiKey === "string"
                    ? settings.apiKey.trim()
                    : "";
            const chromiumExtensionPath =
                settings && typeof settings.chromiumExtensionPath === "string"
                    ? settings.chromiumExtensionPath
                    : "";
            const useChromeChannel = Boolean(settings?.useChromeChannel);

            const payload = {
                apiKey,
                chromiumExtensionPath,
                useChromeChannel,
            };

            if (apiKey) {
                const sync = syncCapsolverApiKeyToExtension(apiKey, payload);
                if (!sync.ok) {
                    return { success: false, error: sync.error };
                }
            } else {
                writeEmptyCapsolverConfig(payload);
            }

            fs.writeFileSync(
                CAPSOLVER_SETTINGS_FILE,
                JSON.stringify(payload, null, 2),
                "utf8",
            );
            return { success: true };
        } catch (error) {
            console.error("Error saving CapSolver settings:", error);
            return { success: false, error: error.message };
        }
    });
}

module.exports = { register };
