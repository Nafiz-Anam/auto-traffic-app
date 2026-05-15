/**
 * Prototype methods attached to BrowserAutomation — mounted via Object.assign in index.js.
 * Covers pre-booking navigation: overlay, page load, cookie banner, login form.
 */
const LoginFlowMethods = {
    /**
     * One small fixed label so you can see which proxy is in use.
     * Previously used addInitScript + multiple evaluate calls + repeated installs,
     * which could duplicate the badge (e.g. top, over CAPTCHA, footer).
     */
    async installProxyOverlay(page, proxy) {
        const label = `${proxy.host}:${proxy.port}`;
        await page.evaluate((text) => {
            const ATTR = "data-prenota-proxy-overlay";
            document.querySelectorAll(`[${ATTR}]`).forEach((n) => n.remove());
            const id = "__proxy_indicator";
            const old = document.getElementById(id);
            if (old) old.remove();

            const div = document.createElement("div");
            div.id = id;
            div.setAttribute(ATTR, "1");
            div.textContent = text;
            Object.assign(div.style, {
                position: "fixed",
                top: "10px",
                right: "10px",
                fontSize: "14px",
                color: "#166534",
                zIndex: "2147483646",
                background: "#fff",
                padding: "4px 8px",
                border: "2px solid #16a34a",
                borderRadius: "6px",
                fontWeight: "600",
                pointerEvents: "none",
                fontFamily: "system-ui, sans-serif",
                maxWidth: "70vw",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
            });
            (document.body || document.documentElement)?.appendChild(div);
        }, label);
    },

    async gotoWithRetry(page, url, accountLabel) {
        const attempts = 2;
        const timeoutMs = 30000;
        let lastError = null;
        for (let i = 1; i <= attempts; i++) {
            try {
                await page.goto(url, {
                    waitUntil: "commit",
                    timeout: timeoutMs,
                });
                return;
            } catch (err) {
                lastError = err;
                console.error(
                    `[${accountLabel}] goto ${url} (${i}/${attempts}):`,
                    err?.message || err,
                );
                if (i < attempts) {
                    await new Promise((resolve) =>
                        setTimeout(resolve, 1500 * i),
                    );
                }
            }
        }

        const errMsg = String(lastError?.message || lastError || "");
        let detail = `Failed to load ${url}`;
        const oxylabsHint =
            "Oxylabs: confirm host/port and sub-user password in the dashboard, subscription active, " +
            "and your public IP allowlisted if required. Residential endpoints can be slow—retries use a longer timeout. " +
            "Test the proxy in another browser or curl. Special characters in passwords must match exactly in Proxies.";
        if (
            errMsg.includes("ERR_TUNNEL_CONNECTION_FAILED") ||
            errMsg.includes("TUNNEL_CONNECTION")
        ) {
            detail +=
                ". HTTPS tunnel through the proxy failed (ERR_TUNNEL_CONNECTION_FAILED). " +
                oxylabsHint;
        } else if (
            errMsg.includes("ERR_PROXY_CONNECTION_FAILED") ||
            errMsg.includes("ERR_PROXY")
        ) {
            detail +=
                ". Could not connect to the proxy server (ERR_PROXY_*). " +
                "The app is not reaching your configured proxy host: wrong port, firewall/VPN blocking outbound proxy, " +
                "or Oxylabs blocking the connection. " +
                oxylabsHint;
        } else if (errMsg.includes("TIMED_OUT") || errMsg.includes("Timeout")) {
            detail +=
                ". Navigation timed out (slow proxy, blocked route, or target unreachable through this endpoint). " +
                oxylabsHint;
        }

        throw new Error(detail);
    },

    async acceptCookiesPlaywright(page, accountLabel) {
        const selectors = [
            "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
            "#CybotCookiebotDialogBodyButtonAccept",
        ];
        for (const sel of selectors) {
            try {
                const loc = page.locator(sel).first();
                await loc.click({ timeout: 2000 });
                return;
            } catch {
                /* try next */
            }
        }
        try {
            await page
                .getByRole("button", { name: /accetta/i })
                .first()
                .click({
                    timeout: 2000,
                });
        } catch {
            /* optional */
        }
    },

    async loginPlaywright(page, account) {
        const email = page
            .getByRole("textbox", { name: /email/i })
            .or(page.getByPlaceholder(/email/i))
            .or(page.locator("input[type='email']"))
            .first();

        const password = page
            .getByPlaceholder(/password/i)
            .or(page.locator("input[type='password']"))
            .first();

        await email.waitFor({ state: "visible", timeout: 25000 });
        await password.waitFor({ state: "visible", timeout: 25000 });

        await email.click();
        await email.fill(account.username);
        await password.click();
        await password.fill(account.password);

        // Site uses custom Vuetify-style buttons; not always exposed with role=button.
        let clicked = false;

        const submitCandidates = [
            page.locator("a.btn, button.btn, input[type='submit']").filter({
                hasText: /accedi/i,
            }),
            page.locator("a.btn.btn-primary, button.btn.btn-primary"),
        ];

        for (const candidate of submitCandidates) {
            try {
                const btn = candidate.first();
                await btn.waitFor({ state: "visible", timeout: 2000 });
                const label = (
                    await btn.innerText().catch(() => "")
                ).toLowerCase();
                if (label.includes("spid")) {
                    continue;
                }
                await btn.scrollIntoViewIfNeeded().catch(() => {});
                await btn.click({ force: true });
                clicked = true;
                break;
            } catch {
                // Try next candidate
            }
        }

        if (!clicked) {
            // DOM fallback based on visible text/value.
            clicked = await page.evaluate(() => {
                const norm = (s) =>
                    (s || "").replace(/\s+/g, " ").trim().toLowerCase();
                const nodes = Array.from(
                    document.querySelectorAll(
                        "a.btn, button.btn, input[type='submit'], a, button",
                    ),
                );
                const target = nodes.find((el) => {
                    const t = norm(el.textContent || el.value || "");
                    if (!t.includes("accedi")) return false;
                    if (t.includes("spid")) return false;
                    const st = window.getComputedStyle(el);
                    return st.display !== "none" && st.visibility !== "hidden";
                });
                if (!target) return false;
                target.dispatchEvent(
                    new MouseEvent("click", {
                        bubbles: true,
                        cancelable: true,
                        view: window,
                    }),
                );
                return true;
            });
        }

        if (!clicked) {
            await page.keyboard.press("Enter").catch(() => {});
        }

        // Check for "Utente sospeso" modal after login click.
        // The modal is rendered by Vue after the login XHR resolves, so we MUST
        // wait — checking body.innerText immediately fires before the response
        // lands and reports "no modal" even when one is about to appear.
        try {
            console.log("Waiting for login response (modal or navigation)...");
            await Promise.race([
                page.waitForNavigation({ waitUntil: "commit", timeout: 15000 }),
                page.waitForFunction(
                    () => {
                        const t = (document.body?.innerText || "").toLowerCase();
                        return (
                            t.includes("utente sospeso") ||
                            t.includes("appuntamento non hai frequentato")
                        );
                    },
                    { timeout: 15000 },
                ),
            ]).catch(() => {});

            console.log("Checking for Utente sospeso modal...");
            const hasSuspendedModal = await page.evaluate(() => {
                const modalText = document.body.innerText || "";
                return (
                    modalText.includes("Utente sospeso") ||
                    modalText.includes("utente sospeso") ||
                    modalText.includes("appuntamento non hai frequentato")
                );
            });

            if (hasSuspendedModal) {
                console.log(
                    "Utente sospeso modal detected, waiting for modal to render...",
                );

                // Wait dynamically for the SI, HO CAPITO button to become available
                const buttonReady = await page
                    .waitForFunction(
                        () => {
                            const buttons = [
                                ...document.querySelectorAll(
                                    "button, .v-btn, [role='button']",
                                ),
                            ];
                            const siHoCapitoBtn = buttons.find((btn) => {
                                const text = (
                                    btn.innerText ||
                                    btn.textContent ||
                                    ""
                                )
                                    .trim()
                                    .toUpperCase();
                                return (
                                    text.includes("SI, HO CAPITO") ||
                                    text.includes("SI HO CAPITO") ||
                                    text.includes("HO CAPITO")
                                );
                            });

                            if (!siHoCapitoBtn) return false;

                            // Check if button is visible and clickable
                            const style =
                                window.getComputedStyle(siHoCapitoBtn);
                            return (
                                style.display !== "none" &&
                                style.visibility !== "hidden" &&
                                style.opacity !== "0" &&
                                !siHoCapitoBtn.disabled
                            );
                        },
                        { timeout: 10000 },
                    )
                    .catch(() => false);

                if (buttonReady) {
                    console.log("SI, HO CAPITO button is ready, clicking...");

                    // Click the "SI, HO CAPITO" button
                    const buttonClicked = await page.evaluate(() => {
                        const buttons = [
                            ...document.querySelectorAll(
                                "button, .v-btn, [role='button']",
                            ),
                        ];
                        const siHoCapitoBtn = buttons.find((btn) => {
                            const text = (
                                btn.innerText ||
                                btn.textContent ||
                                ""
                            )
                                .trim()
                                .toUpperCase();
                            return (
                                text.includes("SI, HO CAPITO") ||
                                text.includes("SI HO CAPITO") ||
                                text.includes("HO CAPITO")
                            );
                        });

                        if (!siHoCapitoBtn) return false;

                        // Check if button is visible
                        const style = window.getComputedStyle(siHoCapitoBtn);
                        if (
                            style.display === "none" ||
                            style.visibility === "hidden" ||
                            style.opacity === "0"
                        ) {
                            return false;
                        }

                        // Use real mouse events
                        const r = siHoCapitoBtn.getBoundingClientRect();
                        ["mousedown", "mouseup", "click"].forEach((t) =>
                            siHoCapitoBtn.dispatchEvent(
                                new MouseEvent(t, {
                                    bubbles: true,
                                    cancelable: true,
                                    clientX: r.left + r.width / 2,
                                    clientY: r.top + r.height / 2,
                                }),
                            ),
                        );
                        return true;
                    });

                    if (buttonClicked) {
                        console.log(
                            "Successfully clicked SI, HO CAPITO button",
                        );
                        // Wait dynamically for modal to close and navigation to start
                        await page
                            .waitForFunction(
                                () => {
                                    const modalText =
                                        document.body.innerText || "";
                                    return (
                                        !modalText.includes("Utente sospeso") &&
                                        !modalText.includes("utente sospeso")
                                    );
                                },
                                { timeout: 10000 },
                            )
                            .catch(() => {});
                    } else {
                        console.log(
                            "SI, HO CAPITO button not found or not clickable",
                        );
                    }
                } else {
                    console.log(
                        "SI, HO CAPITO button did not become ready within timeout",
                    );
                }
            } else {
                console.log("No Utente sospeso modal detected");
            }
        } catch (error) {
            console.log(
                "Error checking for Utente sospeso modal:",
                error.message,
            );
        }

        // Wait for navigation to complete instead of fixed delay
        try {
            await page
                .waitForNavigation({ waitUntil: "commit", timeout: 10000 })
                .catch(() => {});
        } catch {
            // Continue even if navigation fails
        }
    },
};

module.exports = { LoginFlowMethods };
