const fs = require("node:fs");
const path = require("node:path");
const { DATA_PATH, CAPSOLVER_SETTINGS_FILE } = require("../data/paths.js");
const { loadCapsolverSettingsData } = require("../data/capsolver.js");
const {
    resolveChromiumExtensionDir,
    findProjectCapsolverExtensionDir,
} = require("../automation/extension-loader.js");

function syncApiKeyToExtension(apiKey, chromiumExtensionPath) {
    try {
        const extDir =
            resolveChromiumExtensionDir(chromiumExtensionPath) ||
            findProjectCapsolverExtensionDir();
        if (!extDir) {
            console.warn("CapSolver extension dir not found — skipping config.js sync");
            return;
        }
        const configFile = path.join(extDir, "assets", "config.js");
        if (!fs.existsSync(configFile)) {
            console.warn(`CapSolver config.js not found at ${configFile} — skipping sync`);
            return;
        }
        const current = fs.readFileSync(configFile, "utf8");
        const updated = current.replace(/apiKey:\s*"[^"]*"/, `apiKey: "${apiKey}"`);
        fs.writeFileSync(configFile, updated, "utf8");
        console.log(`CapSolver API key synced to ${configFile}`);
    } catch (err) {
        console.error("Failed to sync API key to CapSolver extension config.js:", err.message);
    }
}

function register(ipcMain) {
    ipcMain.handle("load-capsolver-settings", async () => {
        return loadCapsolverSettingsData();
    });

    ipcMain.handle("save-capsolver-settings", async (event, settings) => {
        try {
            const apiKey =
                settings && typeof settings.apiKey === "string"
                    ? settings.apiKey
                    : "";
            const chromiumExtensionPath =
                settings && typeof settings.chromiumExtensionPath === "string"
                    ? settings.chromiumExtensionPath
                    : "";
            const useChromeChannel = Boolean(settings?.useChromeChannel);
            if (!fs.existsSync(DATA_PATH)) {
                fs.mkdirSync(DATA_PATH, { recursive: true });
            }
            fs.writeFileSync(
                CAPSOLVER_SETTINGS_FILE,
                JSON.stringify(
                    { apiKey, chromiumExtensionPath, useChromeChannel },
                    null,
                    2,
                ),
            );
            syncApiKeyToExtension(apiKey, chromiumExtensionPath);
            return { success: true };
        } catch (error) {
            console.error("Error saving CapSolver settings:", error);
            return { success: false, error: error.message };
        }
    });
}

module.exports = { register };
