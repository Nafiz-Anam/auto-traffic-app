const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");
const uuidv4 = () => require("node:crypto").randomUUID();

const { LOGIN_URL } = require("./constants.js");
const {
    getDefaultChromiumArgs,
    getChromiumArgsForExtensions,
} = require("./chromium-args.js");
const {
    launchPersistentContextWithExtension,
    resolveAutomationExtensionDir,
    resolveAutomationExtensionDirs,
} = require("./extension-loader.js");
const { buildPlaywrightProxyConfig } = require("./proxy-config.js");

/**
 * Prototype methods attached to BrowserAutomation — mounted via Object.assign in index.js.
 * Owns the orchestrator surface (start/stop/getStatus) and the per-account lifecycle
 * (browser launch, page wiring, handoff to login/service/booking flows).
 *
 * Relies on sibling methods via `this`:
 *   - this.gotoWithRetry / this.loginPlaywright / this.installProxyOverlay  (login-flow.js)
 *   - this.completeServiceFlow                                              (service-flow.js)
 */
const AccountRunnerMethods = {
    async start(accounts, proxies, config = {}) {
        if (this.isRunning) {
            throw new Error("Automation is already running");
        }

        this.isRunning = true;
        this.stopFlag = false;

        console.log(
            "CAPTCHA: using unpacked CapSolver extension in Chromium only (no in-app API).",
        );

        const windowCount = Math.min(Math.max(config.windowCount || 1, 1), 20);
        const useProxy = config?.useProxy !== false;

        let selectedProxies = [];
        let sessions;
        if (useProxy) {
            selectedProxies = proxies.filter(
                (p) => p.type !== "web_unblocker",
            );
            if (selectedProxies.length === 0) {
                throw new Error(
                    "No HTTP proxies available. Remove Web Unblocker-only entries and add at least one standard HTTP proxy (host, port, user, pass).",
                );
            }
            const maxSessions = Math.min(
                windowCount,
                accounts.length,
                selectedProxies.length,
            );
            sessions = accounts.slice(0, maxSessions).map((account, index) => ({
                account,
                proxy: selectedProxies[index % selectedProxies.length],
            }));
            console.log(`Using ${selectedProxies.length} HTTP proxy(es)`);
        } else {
            const maxSessions = Math.min(windowCount, accounts.length);
            sessions = accounts
                .slice(0, maxSessions)
                .map((account) => ({ account, proxy: null }));
            console.log(
                "Proxy disabled — using direct connection for all windows",
            );
        }

        console.log(
            `Starting automation with ${sessions.length} windows (requested: ${windowCount})`,
        );

        const LAUNCH_DELAY_MS = 3000;
        sessions.forEach(({ account, proxy }, index) => {
            if (this.stopFlag) return;
            setTimeout(() => {
                if (this.stopFlag) return;
                this.runAccount(account, proxy, config, useProxy ? selectedProxies : []).catch((error) => {
                    console.error(
                        `Error running account ${account.username}:`,
                        error,
                    );
                });
            }, index * LAUNCH_DELAY_MS);
        });
    },

    async runAccount(account, proxy, config, proxyPool = []) {
        const browserId = uuidv4();
        let browser = null;
        let context = null;
        this.activeCount++;

        const cleanup = async () => {
            this.browsers.delete(browserId);
            try { if (browser) await browser.close(); } catch {}
            try { if (context) await context.close(); } catch {}
            this.activeCount--;
            if (this.activeCount <= 0) {
                this.activeCount = 0;
                this.isRunning = false;
            }
        };

        const winLog = (msg) => {
            console.log(`[${account.username}] ${msg}`);
            if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                this.mainWindow.webContents.send("automation-log", {
                    account: account.username,
                    message: msg,
                    timestamp: Date.now(),
                });
            }
        };

        try {
            // STEP 1: Launch browser with proxy and performance optimizations
            winLog("STEP 1: Launching browser...");
            let proxyConfig = null;
            if (proxy) {
                proxyConfig = buildPlaywrightProxyConfig(proxy);
                if (!proxyConfig) {
                    throw new Error(
                        "Invalid proxy: need host and port in Proxies settings.",
                    );
                }
                console.log(
                    `[${account.username}] Using HTTP proxy ${proxy.host}:${proxy.port} (context proxy)`,
                );
            } else {
                console.log(
                    `[${account.username}] Proxy disabled — using direct connection`,
                );
            }

            const extDirs = resolveAutomationExtensionDirs(config);
            const hasExt = extDirs.length > 0;
            const baseArgs = getDefaultChromiumArgs();

            const launchSession = async (proxyConf) => {
                const ctxOpts = {
                    viewport: null,
                    ignoreHTTPSErrors: true,
                    javaScriptEnabled: true,
                    bypassCSP: true,
                };
                if (proxyConf) ctxOpts.proxy = proxyConf;

                if (hasExt) {
                    const userDataDir = path.join(
                        os.tmpdir(),
                        "prenota-playwright-profiles",
                        browserId,
                    );
                    fs.mkdirSync(userDataDir, { recursive: true });
                    const joined = extDirs.join(",");
                    const extArgs = [
                        ...getChromiumArgsForExtensions(),
                        `--disable-extensions-except=${joined}`,
                        `--load-extension=${joined}`,
                    ];
                    const ctx = await launchPersistentContextWithExtension(
                        userDataDir,
                        ctxOpts,
                        extArgs,
                        { useChromeChannel: config?.useChromeChannel === true },
                    );
                    return { browser: ctx.browser(), context: ctx };
                }
                const br = await chromium.launch({
                    headless: false,
                    args: baseArgs,
                });
                const ctx = await br.newContext(ctxOpts);
                return { browser: br, context: ctx };
            };

            if (hasExt) {
                console.log(
                    `[${account.username}] Chromium extension folders: ${extDirs.join(" | ")}`,
                );
            }

            ({ browser, context } = await launchSession(proxyConfig));
            if (hasExt && !browser) {
                console.warn(
                    `[${account.username}] context.browser() is null (Chrome+persistent) — using context for lifecycle; UI stays open.`,
                );
            }

            this.browsers.set(browserId, { browser, context });

            winLog(
                `STEP 2: Browser context ready (extensions=${extDirs.length})`,
            );

            let page = context.pages()[0] || (await context.newPage());

            // Block unnecessary resources for faster loading
            await page.route("**/*.{png,jpg,jpeg,gif,svg,ico,webp}", (route) =>
                route.abort(),
            );
            await page.route("**/*.{mp3,mp4,avi,mov,wmv,flv,webm}", (route) =>
                route.abort(),
            );
            await page.route("**/*.{woff,woff2,ttf,eot}", (route) =>
                route.abort(),
            );
            await page.route("**/*analytics*", (route) => route.abort());
            await page.route("**/*ads*", (route) => route.abort());
            await page.route("**/*tracking*", (route) => route.abort());
            await page.route("**/*facebook*", (route) => route.abort());
            await page.route("**/*google-analytics*", (route) => route.abort());
            await page.route("**/*doubleclick*", (route) => route.abort());

            // Set shorter timeouts for faster failure detection
            page.setDefaultNavigationTimeout(60000);
            page.setDefaultTimeout(30000);

            // Shared helpers for re-launching the browser with a new proxy.
            // Used by STEP 3 (connectivity validation) and STEP 4-6 (login retry).
            const wireRoutesAndTimeouts = async (p) => {
                await p.route("**/*ads*", (route) => route.abort());
                await p.route("**/*tracking*", (route) => route.abort());
                await p.route("**/*facebook*", (route) => route.abort());
                await p.route("**/*google-analytics*", (route) =>
                    route.abort(),
                );
                await p.route("**/*doubleclick*", (route) => route.abort());
                p.setDefaultNavigationTimeout(60000);
                p.setDefaultTimeout(30000);
            };

            const relaunchWithProxy = async (newProxy) => {
                this.browsers.delete(browserId);
                try { if (context) await context.close(); } catch {}
                try { if (browser) await browser.close(); } catch {}
                browser = null;
                context = null;
                ({ browser, context } = await launchSession(
                    buildPlaywrightProxyConfig(newProxy),
                ));
                this.browsers.set(browserId, { browser, context });
                page = context.pages()[0] || (await context.newPage());
                await wireRoutesAndTimeouts(page);
            };

            // Proxy pool & current proxy tracker — hoisted so STEP 4-6 can
            // also rotate when login fails (slow page load, etc.)
            let orderedPool = [];
            let currentProxy = proxy ? { ...proxy } : null;
            let currentProxyIdx = 0;
            if (proxy) {
                const pool = proxyPool.length > 0 ? proxyPool : [proxy];
                const startIdx = pool.findIndex(
                    (p) =>
                        p.host === proxy.host && p.port === String(proxy.port),
                );
                orderedPool =
                    startIdx <= 0
                        ? pool
                        : [
                              ...pool.slice(startIdx),
                              ...pool.slice(0, startIdx),
                          ];
            }

            // STEP 3: Validate proxy connectivity — rotate through pool on failure
            winLog("STEP 3: Validating proxy connectivity...");
            if (proxy) {
                let proxyWorking = false;

                for (let attempt = 0; attempt < orderedPool.length; attempt++) {
                    // Bail out immediately if stop was requested
                    if (this.stopFlag) {
                        winLog("Stop requested — aborting proxy retry.");
                        return cleanup();
                    }

                    if (attempt > 0) {
                        if (orderedPool.length === 1) {
                            winLog(
                                "ERROR: Proxy failed and no other proxies available. Add more proxies and retry.",
                            );
                            return cleanup();
                        }
                        currentProxy = { ...orderedPool[attempt] };
                        currentProxyIdx = attempt;
                        winLog(
                            `Proxy ${orderedPool[attempt - 1].host}:${orderedPool[attempt - 1].port} failed — trying next: ${currentProxy.host}:${currentProxy.port}`,
                        );
                        try {
                            await relaunchWithProxy(currentProxy);
                        } catch (launchError) {
                            console.error(
                                `[${account.username}] Error launching browser with proxy ${currentProxy.host}:${currentProxy.port}: ${launchError.message}`,
                            );
                            continue;
                        }
                    }

                    console.log(
                        `[${account.username}] Proxy attempt ${attempt + 1}/${orderedPool.length}: ${currentProxy.host}:${currentProxy.port}`,
                    );
                    proxyWorking = await this.validateProxyConnectivity(
                        page,
                        currentProxy,
                    );

                    if (proxyWorking) {
                        console.log(
                            `[${account.username}] Proxy working: ${currentProxy.host}:${currentProxy.port}`,
                        );
                        break;
                    }
                }

                if (!proxyWorking) {
                    winLog(
                        `ERROR: All ${orderedPool.length} proxy(s) failed. No working proxy found — stopping this account.`,
                    );
                    return cleanup();
                }
            } else {
                console.log(
                    `[${account.username}] Using direct connection (no proxy)`,
                );
            }

            // STEP 4 + 6: Navigate to login page and submit credentials.
            // If the login page is too slow (email/password locator times out)
            // or navigation fails, close this browser and rotate to the next
            // proxy in the pool. Loops through every untried proxy before
            // giving up.
            let loginOk = false;
            const maxLoginAttempts = Math.max(orderedPool.length || 1, 1);
            for (let lAttempt = 1; lAttempt <= maxLoginAttempts; lAttempt++) {
                if (this.stopFlag) {
                    return cleanup();
                }

                winLog(
                    `STEP 4: Navigating to login page (attempt ${lAttempt}/${maxLoginAttempts}${currentProxy ? `, proxy ${currentProxy.host}:${currentProxy.port}` : ""})...`,
                );
                let navOk = true;
                try {
                    await this.gotoWithRetry(
                        page,
                        LOGIN_URL,
                        account.username,
                    );
                } catch (err) {
                    navOk = false;
                    console.error(
                        `[${account.username}] Login navigation:`,
                        err?.message || err,
                    );
                }

                if (navOk) {
                    winLog("STEP 6: Logging in with credentials...");
                    try {
                        await this.loginPlaywright(page, account);
                        loginOk = true;
                        break;
                    } catch (err) {
                        console.error(
                            `[${account.username}] Login:`,
                            err?.message || err,
                        );
                    }
                }

                // Login or navigation failed — rotate to the next proxy and retry.
                if (lAttempt >= maxLoginAttempts || orderedPool.length <= 1) {
                    winLog(
                        `ERROR: Login failed on all ${maxLoginAttempts} proxy(s). Stopping this account.`,
                    );
                    break;
                }

                currentProxyIdx = (currentProxyIdx + 1) % orderedPool.length;
                currentProxy = { ...orderedPool[currentProxyIdx] };
                winLog(
                    `Login page too slow — closing browser and retrying with proxy ${currentProxy.host}:${currentProxy.port}...`,
                );
                try {
                    await relaunchWithProxy(currentProxy);
                } catch (launchError) {
                    console.error(
                        `[${account.username}] Relaunch with proxy ${currentProxy.host}:${currentProxy.port} failed: ${launchError.message}`,
                    );
                }
            }

            if (!loginOk) {
                return cleanup();
            }

            // STEP 7+: Heading-driven booking wizard (service → summary)
            winLog("STEP 7: Starting heading-driven booking wizard...");
            if (currentProxy) {
                await this.installProxyOverlay(page, currentProxy).catch(() => {});
            }
            await page
                .waitForURL(/prenotazione/i, { timeout: 30000 })
                .catch(() => {});
            await this.runBookingWizard(page, account.username, config);

            winLog(
                currentProxy
                    ? `Browser running with proxy ${currentProxy.host}:${currentProxy.port}`
                    : "Browser running with direct connection (no proxy)",
            );

            // Keep session alive until Stop, disconnect, or all pages closed
            while (!this.stopFlag) {
                await new Promise((resolve) => setTimeout(resolve, 1000));
                try {
                    if (browser) {
                        if (!browser.isConnected()) {
                            break;
                        }
                        continue;
                    }
                    if (context) {
                        const b = context.browser();
                        if (b && !b.isConnected()) {
                            break;
                        }
                        if (!b) {
                            const pages = context.pages();
                            if (
                                pages.length === 0 ||
                                pages.every((p) => p.isClosed())
                            ) {
                                break;
                            }
                        }
                        continue;
                    }
                    break;
                } catch {
                    break;
                }
            }

            // User closed the window or stop was requested
            await cleanup();

        } catch (error) {
            console.error(
                `Browser fatal error for ${account.username}:`,
                error,
            );
            await cleanup();
        }
    },

    async stop() {
        console.log("Stopping all browsers...");
        this.stopFlag = true;

        const closePromises = [];
        for (const [, session] of this.browsers) {
            const { browser, context } =
                session && typeof session === "object" && "context" in session
                    ? session
                    : { browser: session, context: null };
            if (browser) {
                closePromises.push(
                    browser
                        .close()
                        .catch((error) =>
                            console.error("Error closing browser:", error),
                        ),
                );
            } else if (context) {
                closePromises.push(
                    context
                        .close()
                        .catch((error) =>
                            console.error(
                                "Error closing browser context:",
                                error,
                            ),
                        ),
                );
            }
        }

        await Promise.all(closePromises);
        this.browsers.clear();
        this.isRunning = false;

        console.log("All browsers stopped");
    },

    getStatus() {
        return {
            running: this.isRunning,
            browsers: Array.from(this.browsers.keys()),
            count: this.browsers.size,
        };
    },

    async validateProxyConnectivity(page, proxy) {
        try {
            console.log(
                `Testing proxy connectivity: ${proxy.host}:${proxy.port}`,
            );

            // Test 1: Try to fetch a simple endpoint through proxy
            const testResult = await page.evaluate(async () => {
                try {
                    const response = await fetch("https://httpbin.org/ip", {
                        method: "GET",
                        timeout: 15000,
                        signal: AbortSignal.timeout(15000),
                    });

                    if (response.ok) {
                        const data = await response.json();
                        return {
                            success: true,
                            ip: data.origin,
                            proxyWorking: true,
                        };
                    }
                    return { success: false, proxyWorking: false };
                } catch (error) {
                    return {
                        success: false,
                        proxyWorking: false,
                        error: error.message,
                    };
                }
            });

            if (testResult.success && testResult.proxyWorking) {
                console.log(
                    `✅ Proxy validation successful - IP: ${testResult.ip}`,
                );
                return true;
            } else {
                console.log(
                    `❌ Proxy validation failed: ${testResult.error || "Unknown error"}`,
                );
                return false;
            }
        } catch (error) {
            console.error(`Proxy validation error: ${error.message}`);
            return false;
        }
    },
};

module.exports = { AccountRunnerMethods };
