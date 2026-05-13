const { BrowserAutomation } = require("../browser-automation.js");
const { loadAccountsData } = require("../data/accounts.js");
const { loadProxiesData, expandProxyPool } = require("../data/proxies.js");
const { loadCapsolverSettingsData } = require("../data/capsolver.js");
const { syncCapsolverApiKeyToExtension } = require("../automation/capsolver-config-sync.js");

function redactAutomationConfigForLog(config) {
    if (!config || typeof config !== "object") return config;
    const { chromiumExtensionPath, ...rest } = config;
    return {
        ...rest,
        chromiumExtensionPath: chromiumExtensionPath ? "[set]" : undefined,
    };
}

/**
 * `ctx` is a mutable container shared with main.js: `ctx.mainWindow` and
 * `ctx.browserAutomation` are read/written here and by lifecycle code in main.js.
 */
function register(ipcMain, ctx) {
    ipcMain.handle("start-automation", async (event, config) => {
        try {
            console.log(
                "Received start-automation request with config:",
                JSON.stringify(redactAutomationConfigForLog(config), null, 2),
            );

            if (!ctx.browserAutomation) {
                ctx.browserAutomation = new BrowserAutomation(ctx.mainWindow);
            }

            const capsolverStored = loadCapsolverSettingsData();
            const mergedConfig = {
                ...config,
                chromiumExtensionPath:
                    (config?.chromiumExtensionPath &&
                        String(config.chromiumExtensionPath).trim()) ||
                    capsolverStored.chromiumExtensionPath ||
                    "",
                useChromeChannel:
                    typeof config?.useChromeChannel === "boolean"
                        ? config.useChromeChannel
                        : Boolean(capsolverStored.useChromeChannel),
            };

            const apiKey = (capsolverStored.apiKey || "").trim();
            if (apiKey) {
                const sync = syncCapsolverApiKeyToExtension(
                    apiKey,
                    mergedConfig,
                );
                if (!sync.ok) {
                    console.warn(
                        "CapSolver API key sync before automation:",
                        sync.error,
                    );
                }
            } else {
                console.warn(
                    "No CapSolver API key saved — extension may not solve captchas until you add one in the CapSolver tab.",
                );
            }

            const accounts = await loadAccountsData();
            const rawProxies = await loadProxiesData();
            const proxies = expandProxyPool(rawProxies);

            const usableProxies = Array.isArray(proxies)
                ? proxies.filter((p) => p && p.type !== "web_unblocker")
                : [];
            console.log(
                `Proxy pool expanded: ${rawProxies.length} entries → ${proxies.length} proxies (port ranges applied)`,
            );
            const windowCount = Math.min(
                Math.max(Number(config?.windowCount) || 1, 1),
                20,
            );
            const parallelSessions = Math.min(
                windowCount,
                accounts.length,
            );

            console.log(
                `Loaded ${accounts.length} accounts and ${proxies.length} proxy entries (${usableProxies.length} HTTP); ` +
                    `windows=${windowCount}, parallel sessions=${parallelSessions}`,
            );

            const useProxy = config?.useProxy !== false;

            if (useProxy) {
                if (usableProxies.length === 0) {
                    throw new Error(
                        "No HTTP proxies configured. Add at least one standard proxy.",
                    );
                }

                if (usableProxies.length < parallelSessions) {
                    throw new Error(
                        `Not enough proxies: need ${parallelSessions} for ${parallelSessions} parallel window(s), but only ${usableProxies.length} HTTP proxy/proxies are configured.`,
                    );
                }
            } else {
                console.log("Proxy disabled via toggle — launching browsers with direct connection.");
            }

            ctx.browserAutomation
                .start(accounts, proxies, mergedConfig)
                .catch((err) => {
                    console.error("Background automation error:", err.message);
                });

            console.log("Automation started successfully, returning success");
            return { success: true };
        } catch (error) {
            console.error("Error starting automation:", error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle("stop-automation", async () => {
        try {
            if (ctx.browserAutomation) {
                await ctx.browserAutomation.stop();
            }
            return { success: true };
        } catch (error) {
            console.error("Error stopping automation:", error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle("get-automation-status", async () => {
        if (ctx.browserAutomation) {
            return ctx.browserAutomation.getStatus();
        }
        return { running: false, browsers: [] };
    });
}

module.exports = { register };
