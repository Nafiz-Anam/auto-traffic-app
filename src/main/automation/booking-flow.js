const { resolveAutomationExtensionDir } = require("./extension-loader.js");
const {
    isRecaptchaEnterpriseQuotaBlocked,
    logRecaptchaSiteQuotaBlocked,
} = require("./captcha.js");
const {
    STEP_ORDER,
    detectWizardStep,
    waitForWizardStep,
} = require("./booking-wizard-steps.js");

/**
 * Prototype methods attached to BrowserAutomation — mounted via Object.assign in index.js.
 * Owns STEP 8 and all sub-steps after service+duplicato+AVANTI: structure, date/time,
 * additional info, and final checkbox/CAPTCHA/PRENOTA.
 *
 * Relies on sibling methods via `this`:
 *   - this._forceCaptchaTokenApply  (captcha.js)
 */
const BookingFlowMethods = {
    /**
     * Race the next backend XHR/fetch against a short hard timeout. After a
     * step action (AVANTI click, etc.) the Vue SPA loads the next step's data
     * via the site's API; reacting to that response is faster than polling
     * the DOM. Caller fires this BEFORE clicking the trigger so we don't miss
     * the response.
     */
    waitForBackendResponse(page, timeoutMs = 6000) {
        return page
            .waitForResponse(
                (res) => {
                    const url = res.url();
                    // Same-origin API calls — not static assets.
                    if (!/prenotafacile\.poliziadistato\.it/i.test(url)) {
                        return false;
                    }
                    if (/\.(?:js|css|png|jpe?g|svg|gif|ico|woff2?|ttf|eot)(?:\?|$)/i.test(url)) {
                        return false;
                    }
                    return res.status() < 500;
                },
                { timeout: timeoutMs },
            )
            .catch(() => null);
    },

    /**
     * Wait for a wizard step heading to be present in the DOM. The site renders
     * step titles as `<span class="display-1">` (Vuetify), not real h-tags.
     * Checking body.innerText would match unrelated text like stepper labels;
     * scoping to the typography classes avoids that.
     */
    async waitForStepHeading(page, headingText, timeoutMs = 15000) {
        try {
            await page.waitForFunction(
                (needle) => {
                    const norm = (s) =>
                        (s || "").toLowerCase().replace(/\s+/g, " ").trim();
                    const target = norm(needle);
                    const headings = document.querySelectorAll(
                        ".display-1, .display-2, .display-3, .display-4, " +
                            ".text-h1, .text-h2, .text-h3, .text-h4, .text-h5, .text-h6, " +
                            ".headline, h1, h2, h3, h4, h5, h6, " +
                            ".v-card-title, .v-card__title, " +
                            ".v-toolbar-title, .v-toolbar__title",
                    );
                    for (const el of headings) {
                        const s = window.getComputedStyle(el);
                        if (
                            s.display === "none" ||
                            s.visibility === "hidden" ||
                            s.opacity === "0"
                        )
                            continue;
                        const t = norm(el.innerText || el.textContent || "");
                        if (t.includes(target)) return true;
                    }
                    return false;
                },
                headingText,
                { timeout: timeoutMs },
            );
            return true;
        } catch {
            return false;
        }
    },

    async refreshWizardPage(page) {
        await page
            .reload({ waitUntil: "commit", timeout: 30000 })
            .catch(() => {});
        await page
            .waitForLoadState("domcontentloaded", { timeout: 10000 })
            .catch(() => {});
    },

    async goBackOneWizardStep(page, accountLabel) {
        const indietroClicked = await page.evaluate(() => {
            const selectors = [
                "button",
                ".v-btn",
                "[role='button']",
                "a.v-btn",
                ".v-btn--contained",
                ".v-btn--elevated",
            ];

            let indietroBtn = null;

            for (const selector of selectors) {
                const buttons = [...document.querySelectorAll(selector)];
                indietroBtn = buttons.find((btn) => {
                    const text = (btn.innerText || btn.textContent || "")
                        .trim()
                        .toUpperCase();
                    return text === "INDIETRO" || text.includes("INDIETRO");
                });
                if (indietroBtn) break;
            }

            if (!indietroBtn) {
                const allElements = [...document.querySelectorAll("*")];
                indietroBtn = allElements.find((el) => {
                    const text = (el.innerText || el.textContent || "").trim();
                    return (
                        text.toUpperCase() === "INDIETRO" &&
                        (el.tagName === "BUTTON" ||
                            el.tagName === "A" ||
                            el.getAttribute("role") === "button")
                    );
                });
            }

            if (!indietroBtn) return false;

            const style = window.getComputedStyle(indietroBtn);
            if (
                style.display === "none" ||
                style.visibility === "hidden" ||
                style.opacity === "0" ||
                indietroBtn.disabled
            ) {
                return false;
            }

            indietroBtn.scrollIntoView({ block: "center" });
            const r = indietroBtn.getBoundingClientRect();
            ["mousedown", "mouseup", "click"].forEach((t) =>
                indietroBtn.dispatchEvent(
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

        if (indietroClicked) {
            console.log(
                `[${accountLabel}] Clicked INDIETRO to go back one wizard step`,
            );
            await page
                .waitForLoadState("domcontentloaded", { timeout: 10000 })
                .catch(() => {});
            return true;
        }

        console.log(
            `[${accountLabel}] INDIETRO not available — using browser back`,
        );
        await page.goBack({ timeout: 10000 }).catch(() => {});
        await page
            .waitForLoadState("domcontentloaded", { timeout: 10000 })
            .catch(() => {});
        return false;
    },

    async runWizardStep(page, accountLabel, config, stepId) {
        switch (stepId) {
            case "service":
                return this.handleServiceSelection(page, accountLabel, config);
            case "structure":
                await this.handleStructureSelection(page, accountLabel);
                return true;
            case "date":
                await this.handleDateTimeSelection(page, accountLabel);
                return true;
            case "additional":
                await this.handleAdditionalInfo(page, accountLabel);
                return true;
            case "summary":
                return this.handleFinalSteps(page, accountLabel, config);
            default:
                throw new Error(`Unknown wizard step: ${stepId}`);
        }
    },

    /**
     * Drive the full booking wizard from whatever step the page heading shows.
     * Recovery: same-step failure → INDIETRO then re-detect (no refresh if INDIETRO worked);
     * redirect to another step → refresh then re-detect.
     */
    async runBookingWizard(page, accountLabel, config) {
        const MAX_ROUNDS = 80;
        const MAX_NO_SLOTS_RETRIES = 10;
        let scheduledWaitDone = false;
        let noSlotsRetries = 0;

        for (let round = 1; round <= MAX_ROUNDS && !this.stopFlag; round++) {
            let stepId = await detectWizardStep(page);
            if (!stepId) {
                stepId = await waitForWizardStep(page, 15000);
            }
            if (!stepId) {
                console.log(
                    `[${accountLabel}] No wizard heading detected — refreshing (round ${round})`,
                );
                await this.refreshWizardPage(page);
                continue;
            }

            if (stepId !== "service" && !scheduledWaitDone) {
                await this.waitUntilScheduledTime(config, accountLabel);
                scheduledWaitDone = true;
                if (this.stopFlag) return;
            }

            console.log(
                `[${accountLabel}] Wizard round ${round}: heading → "${stepId}"`,
            );

            const stepBefore = stepId;
            let stepOk = false;

            try {
                const result = await this.runWizardStep(
                    page,
                    accountLabel,
                    config,
                    stepId,
                );
                if (stepId === "summary") {
                    if (result === true) {
                        console.log(
                            `[${accountLabel}] Booking completed successfully.`,
                        );
                        return;
                    }
                    stepOk = false;
                } else {
                    stepOk = result !== false;
                }
            } catch (error) {
                // "No appointments available" on the date step — click INDIETRO
                // to retry from the previous step. Cap retries so the loop
                // can't run forever.
                if (error && error.code === "NO_SLOTS") {
                    noSlotsRetries++;
                    console.log(
                        `[${accountLabel}] No appointments available (retry ${noSlotsRetries}/${MAX_NO_SLOTS_RETRIES}).`,
                    );
                    if (noSlotsRetries > MAX_NO_SLOTS_RETRIES) {
                        console.log(
                            `[${accountLabel}] Reached ${MAX_NO_SLOTS_RETRIES} no-slot retries — stopping wizard.`,
                        );
                        return;
                    }
                    console.log(
                        `[${accountLabel}] Clicking INDIETRO to retry from previous step...`,
                    );
                    const indietroWorked = await this.goBackOneWizardStep(
                        page,
                        accountLabel,
                    );
                    if (!indietroWorked) {
                        await this.refreshWizardPage(page);
                    }
                    continue;
                }
                console.error(
                    `[${accountLabel}] Step "${stepId}" failed: ${error.message}`,
                );
                stepOk = false;
            }

            // After a successful step, wait for the heading to actually change
            // before re-detecting. Uses Playwright's default `raf` polling, so
            // this wakes within one animation frame (~16ms) of the DOM change
            // and falls through fast if it never changes.
            let stepAfter = stepBefore;
            if (stepOk) {
                try {
                    const handle = await page.waitForFunction(
                        ({ steps, headingSelector, prev }) => {
                            const norm = (s) =>
                                (s || "")
                                    .toLowerCase()
                                    .replace(/\s+/g, " ")
                                    .trim();
                            const isVisible = (el) => {
                                const s = window.getComputedStyle(el);
                                if (
                                    s.display === "none" ||
                                    s.visibility === "hidden" ||
                                    s.opacity === "0"
                                )
                                    return false;
                                const r = el.getBoundingClientRect();
                                return r.width > 0 && r.height > 0;
                            };
                            const headings = [
                                ...document.querySelectorAll(headingSelector),
                            ]
                                .filter(isVisible)
                                .map((el) =>
                                    norm(el.innerText || el.textContent || ""),
                                );
                            for (let i = steps.length - 1; i >= 0; i--) {
                                const n = norm(steps[i].heading);
                                if (headings.some((h) => h.includes(n))) {
                                    return steps[i].id === prev ? null : steps[i].id;
                                }
                            }
                            return null;
                        },
                        {
                            steps: [
                                { id: "service", heading: "Seleziona il servizio" },
                                { id: "structure", heading: "Seleziona la struttura" },
                                { id: "date", heading: "Seleziona la data" },
                                { id: "additional", heading: "Informazioni aggiuntive" },
                                { id: "summary", heading: "Riepilogo richiesta" },
                            ],
                            headingSelector:
                                ".display-1, .display-2, .display-3, .display-4, " +
                                ".text-h1, .text-h2, .text-h3, .text-h4, .text-h5, .text-h6, " +
                                ".headline, h1, h2, h3, h4, h5, h6, " +
                                ".v-card-title, .v-card__title, " +
                                ".v-toolbar-title, .v-toolbar__title",
                            prev: stepBefore,
                        },
                        { timeout: 15000 },
                    );
                    stepAfter = (await handle.jsonValue()) || stepBefore;
                } catch {
                    stepAfter = (await detectWizardStep(page)) || stepBefore;
                }
            } else {
                stepAfter = (await detectWizardStep(page)) || stepBefore;
            }

            const orderBefore = STEP_ORDER[stepBefore] ?? -1;
            const orderAfter = STEP_ORDER[stepAfter] ?? -1;

            if (stepId === "summary" && stepOk) {
                return;
            }

            if (stepOk && orderAfter > orderBefore) {
                continue;
            }

            if (stepAfter !== stepBefore) {
                console.log(
                    `[${accountLabel}] Page moved to "${stepAfter}" (was "${stepBefore}") — refresh and re-detect`,
                );
                await this.refreshWizardPage(page);
                continue;
            }

            console.log(
                `[${accountLabel}] Step "${stepBefore}" failed on same page — INDIETRO, then re-detect heading`,
            );
            const indietroWorked = await this.goBackOneWizardStep(
                page,
                accountLabel,
            );
            if (!indietroWorked) {
                await this.refreshWizardPage(page);
            }
        }

        console.log(
            `[${accountLabel}] Wizard stopped after ${MAX_ROUNDS} rounds without completing booking.`,
        );
    },

    async completeBookingFlow(page, accountLabel, config) {
        await this.runBookingWizard(page, accountLabel, config);
    },

    async handleStructureSelection(page, accountLabel) {
        console.log(`[${accountLabel}] Handling structure selection...`);

        // Wait for the heading. Vuetify renders titles as <span class="display-1">.
        await this.waitForStepHeading(page, "Seleziona la struttura", 15000);

        // Try to select the structure. The site renders structures as either
        // a .v-banner__content card (single structure) or .v-list-item rows
        // (multiple structures). If AVANTI is already enabled the structure
        // was auto-selected — skip the click and go straight to AVANTI.
        console.log(`[${accountLabel}] Looking for structure to select...`);
        const clicked = await page.evaluate(() => {
            const fireClick = (el) => {
                const r = el.getBoundingClientRect();
                ["mousedown", "mouseup", "click"].forEach((t) =>
                    el.dispatchEvent(
                        new MouseEvent(t, {
                            bubbles: true,
                            cancelable: true,
                            clientX: r.left + r.width / 2,
                            clientY: r.top + r.height / 2,
                        }),
                    ),
                );
            };

            // Banner layout (single structure shown as a full-width card)
            const banner = document.querySelector(".v-banner__content");
            if (banner) { fireClick(banner); return "banner"; }

            // List layout (multiple structures as list items)
            const listItem = document.querySelector(
                ".v-list-item, .v-banner-on-hover, [role='listitem']",
            );
            if (listItem) { fireClick(listItem); return "list-item"; }

            return null;
        });

        if (clicked) {
            console.log(`[${accountLabel}] Structure clicked (${clicked})`);
            await new Promise((r) => setTimeout(r, 1000));
        } else {
            // No clickable structure found — check if AVANTI is already
            // enabled (auto-selected). If not, throw so the wizard retries.
            const avantiEnabled = await page.evaluate(() =>
                [...document.querySelectorAll("button")].some(
                    (b) => b.innerText.trim() === "AVANTI" && !b.disabled,
                ),
            );
            if (!avantiEnabled) {
                throw new Error(
                    "Structure not found and AVANTI not enabled — cannot proceed",
                );
            }
            console.log(
                `[${accountLabel}] No structure element found but AVANTI is enabled — proceeding`,
            );
        }

        const respPromise = this.waitForBackendResponse(page, 8000);
        await this.clickAvanti(page);
        await respPromise;
    },

    async handleDateTimeSelection(page, accountLabel) {
        console.log(`[${accountLabel}] Handling date and time selection...`);

        // Heading wait: page is already past structure step; 15s is plenty.
        await this.waitForStepHeading(page, "Seleziona la data", 15000);

        // Race: either the "no appointments" alert appears, or the date
        // listbox is rendered. Whichever comes first ends the wait.
        await page
            .waitForFunction(
                () => {
                    const t = (
                        document.body?.innerText || ""
                    ).toLowerCase();
                    if (
                        t.includes("al momento non c'è") ||
                        t.includes("non c'è disponibilità di appuntamenti") ||
                        t.includes("non c'è diponibilità di appuntamenti")
                    ) {
                        return true;
                    }
                    return Boolean(document.querySelector('[role="listbox"]'));
                },
                undefined,
                { timeout: 10000 },
            )
            .catch(() => {});

        // If the "no appointments available" alert is showing, throw a
        // recognizable error. The wizard catches it and clicks INDIETRO
        // to retry from the previous step (up to 10 times).
        const noSlots = await page.evaluate(() => {
            const t = (document.body?.innerText || "").toLowerCase();
            return (
                t.includes("al momento non c'è") ||
                t.includes("non c'è disponibilità di appuntamenti") ||
                t.includes("non c'è diponibilità di appuntamenti")
            );
        });

        if (noSlots) {
            const err = new Error(
                "No appointments available — will retry from previous step",
            );
            err.code = "NO_SLOTS";
            throw err;
        }

        // Listbox is already present (we raced for it above). Short safety
        // wait in case it briefly disappeared.
        const dateListbox = await page.waitForSelector('[role="listbox"]', {
            timeout: 5000,
        });
        const dates = await page
            .locator('[role="listbox"] [role="listitem"]')
            .all();

        for (let i = 0; i < dates.length; i++) {
            const date = dates[i];
            await date.click();

            // Wait for time listbox
            const timeListbox = await page.waitForSelector(
                '[role="listbox"]:nth-of-type(2)',
                { timeout: 10000 },
            );
            const times = await page
                .locator('[role="listbox"]:nth-of-type(2) [role="listitem"]')
                .all();

            // Shuffle times (Fisher-Yates)
            const timeArray = Array.from(times);
            for (let j = timeArray.length - 1; j > 0; j--) {
                const k = Math.floor(Math.random() * (j + 1));
                [timeArray[j], timeArray[k]] = [timeArray[k], timeArray[j]];
            }

            // Try times in random order
            for (const time of timeArray) {
                await time.click();
                await new Promise((resolve) => setTimeout(resolve, 1000));

                await this.clickAvanti(page);
                await new Promise((resolve) => setTimeout(resolve, 1500));

                // Check if we moved past the date page
                const stillOnDatePage = await page.evaluate(() =>
                    document.body.innerText.includes("Seleziona la data"),
                );
                if (!stillOnDatePage) break;
            }

            const stillOnDatePage = await page.evaluate(() =>
                document.body.innerText.includes("Seleziona la data"),
            );
            if (!stillOnDatePage) break;
        }
    },

    async handleAdditionalInfo(page, accountLabel) {
        console.log(`[${accountLabel}] Handling additional information...`);

        // Wait for the actual page heading (Vuetify <span class="display-1">).
        await this.waitForStepHeading(page, "Informazioni aggiuntive", 15000);

        // Click NO option using the same approach as the extension
        console.log(`[${accountLabel}] Looking for NO option...`);
        const clicked = await page.evaluate(() => {
            const no = [...document.querySelectorAll("label")].find(
                (l) => l.innerText.trim() === "NO",
            );
            if (!no) return false;

            // Use the same realClick approach as the extension
            const r = no.getBoundingClientRect();
            ["mousedown", "mouseup", "click"].forEach((t) =>
                no.dispatchEvent(
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

        if (!clicked) {
            throw new Error("NO option not found");
        }

        console.log(`[${accountLabel}] NO option clicked successfully`);

        // Wait for AVANTI to enable. Default raf polling is plenty fast.
        await page.waitForFunction(
            () =>
                [...document.querySelectorAll("button")].find(
                    (b) => b.innerText.trim() === "AVANTI" && !b.disabled,
                ),
            undefined,
            { timeout: 15000 },
        );

        const respPromise = this.waitForBackendResponse(page, 8000);
        await this.clickAvanti(page);
        await respPromise;
    },

    async handleFinalSteps(page, accountLabel, config) {
        console.log(`[${accountLabel}] Handling final steps...`);

        const chromiumExtensionLoaded = Boolean(
            resolveAutomationExtensionDir(config),
        );

        const MAX_FINAL_RETRIES = 10;

        // Track the token used in the previous submit attempt. On retry we
        // must wait for a DIFFERENT token (the stale one is still in the DOM
        // and would otherwise satisfy waitForFunction instantly).
        let lastSubmittedToken = null;

        // Single long-lived helper across all attempts. It loops, fires Vue
        // callbacks every time a new token appears, and skips the stale
        // (already-submitted) one. We stop it on success/exit.
        const captchaCtrl = {
            stop: false,
            ignoreToken: null,
            lastFiredToken: null,
        };
        const helperPromise = this._forceCaptchaTokenApply(
            page,
            accountLabel,
            captchaCtrl,
        ).catch(() => {});

        const stopHelper = async () => {
            captchaCtrl.stop = true;
            await helperPromise.catch(() => {});
        };

        // Clear stale g-recaptcha-response textareas so waitForFunction
        // can't pick up a token from the previous submit.
        const clearStaleCaptcha = async () => {
            try {
                await page.evaluate(() => {
                    const tas = document.querySelectorAll(
                        'textarea[name="g-recaptcha-response"]',
                    );
                    tas.forEach((ta) => {
                        ta.value = "";
                        ["input", "change"].forEach((type) =>
                            ta.dispatchEvent(
                                new Event(type, { bubbles: true }),
                            ),
                        );
                    });
                    try {
                        if (
                            window.grecaptcha &&
                            typeof window.grecaptcha.reset === "function"
                        ) {
                            window.grecaptcha.reset();
                        }
                    } catch (_) {}
                });
            } catch (_) {}
        };

        // Robust real-mouse PRENOTA click. Returns true if a click was
        // dispatched via Playwright (trusted). Synthetic JS fallback removed
        // because Vue rejects isTrusted=false events anyway.
        const clickPrenota = async () => {
            const prenotaLoc = page
                .locator("button, .v-btn, [role='button']")
                .filter({ hasText: /\bPRENOTA\b/i, visible: true })
                .first();
            for (let i = 0; i < 3; i++) {
                try {
                    await prenotaLoc.scrollIntoViewIfNeeded({ timeout: 3000 });
                    await prenotaLoc.click({ timeout: 5000 });
                    return true;
                } catch (e) {
                    console.warn(
                        `[${accountLabel}] PRENOTA click attempt ${i + 1} failed: ${e.message}`,
                    );
                    await new Promise((r) => setTimeout(r, 1000));
                }
            }
            return false;
        };

        // Race success vs redirect-back vs error toast. Returns one of:
        // 'success' | 'redirected' | 'error' | 'timeout'
        const awaitOutcome = async (timeoutMs) => {
            try {
                const outcome = await page.waitForFunction(
                    () => {
                        const t =
                            document.body.innerText ||
                            document.body.textContent ||
                            "";
                        if (
                            t.includes("Complimenti") ||
                            t.includes("prenotazione è stata inserita") ||
                            t.includes("Prenotazione N.")
                        )
                            return "success";
                        if (
                            t.includes("Seleziona la struttura") ||
                            t.includes("Seleziona la data") ||
                            t.includes("Informazioni aggiuntive") ||
                            t.includes("Seleziona l'orario")
                        )
                            return "redirected";
                        if (
                            /errore|riprova più tardi|server.{0,20}error|503|504/i.test(
                                t,
                            )
                        )
                            return "error";
                        return false;
                    },
                    undefined,
                    { timeout: timeoutMs },
                );
                return await outcome.jsonValue();
            } catch (_) {
                return "timeout";
            }
        };

        try {
            for (let attempt = 1; attempt <= MAX_FINAL_RETRIES; attempt++) {
                console.log(
                    `[${accountLabel}] Final step attempt ${attempt}/${MAX_FINAL_RETRIES}`,
                );

                try {
                    // On retry: clear stale token + force-recheck checkbox so
                    // captcha widget remounts and we wait for a fresh token.
                    if (attempt > 1) {
                        await clearStaleCaptcha();
                        captchaCtrl.ignoreToken = lastSubmittedToken;
                    }

                    await this.ensureCheckbox(page, {
                        forceRecheck: attempt > 1,
                    });

                    // Brief wait + scroll so captcha iframe can mount/be
                    // visible. Use waitForSelector instead of fixed sleeps.
                    await page.evaluate(() =>
                        window.scrollTo({
                            top: document.body.scrollHeight,
                            behavior: "smooth",
                        }),
                    );
                    await page
                        .waitForSelector(
                            'iframe[src*="recaptcha"], textarea[name="g-recaptcha-response"]',
                            { timeout: 8000 },
                        )
                        .catch(() => {});

                    if (await isRecaptchaEnterpriseQuotaBlocked(page)) {
                        if (chromiumExtensionLoaded) {
                            console.warn(
                                `[${accountLabel}] reCAPTCHA quota warning on page; continuing because Chromium extension is configured.`,
                            );
                        } else {
                            logRecaptchaSiteQuotaBlocked(accountLabel);
                            return false;
                        }
                    }

                    console.log(
                        `[${accountLabel}] Waiting for FRESH g-recaptcha-response token...`,
                    );
                    await page.waitForFunction(
                        (ignore) => {
                            const tas = document.querySelectorAll(
                                'textarea[name="g-recaptcha-response"]',
                            );
                            for (const ta of tas) {
                                const v = ta.value && ta.value.trim();
                                if (v && v.length > 20 && v !== ignore)
                                    return true;
                            }
                            return false;
                        },
                        lastSubmittedToken,
                        { timeout: 300000 },
                    );
                    console.log(
                        `[${accountLabel}] Fresh captcha token in DOM.`,
                    );

                    // Wait up to 5s for helper to fire Vue callback for the
                    // new token (it polls at 1Hz). Then click.
                    const tokenReady = await page
                        .waitForFunction(
                            (prev) => {
                                const tas = document.querySelectorAll(
                                    'textarea[name="g-recaptcha-response"]',
                                );
                                for (const ta of tas) {
                                    const v = ta.value && ta.value.trim();
                                    if (v && v.length > 20 && v !== prev)
                                        return v;
                                }
                                return false;
                            },
                            lastSubmittedToken,
                            { timeout: 5000 },
                        )
                        .then((h) => h.jsonValue())
                        .catch(() => null);

                    // Brief settle so Vue's reactive form picks up callback.
                    await new Promise((r) => setTimeout(r, 800));

                    console.log(
                        `[${accountLabel}] Clicking PRENOTA...`,
                    );
                    const clicked = await clickPrenota();
                    if (!clicked) {
                        console.warn(
                            `[${accountLabel}] PRENOTA click failed all 3 tries; retrying flow.`,
                        );
                        if (attempt < MAX_FINAL_RETRIES) {
                            await new Promise((r) => setTimeout(r, 2000));
                            continue;
                        }
                        return false;
                    }

                    // Record token we just submitted so retries skip it.
                    lastSubmittedToken =
                        tokenReady ||
                        (await page
                            .evaluate(() => {
                                const ta = document.querySelector(
                                    'textarea[name="g-recaptcha-response"]',
                                );
                                return ta ? (ta.value || "").trim() : null;
                            })
                            .catch(() => null));

                    console.log(
                        `[${accountLabel}] PRENOTA clicked; awaiting outcome (race success/redirect/error)...`,
                    );

                    const outcome = await awaitOutcome(60000);

                    if (outcome === "success") {
                        const bookingNum = await page
                            .evaluate(() => {
                                const m = (
                                    document.body.innerText || ""
                                ).match(/Prenotazione N\.\s*([\w-]+)/);
                                return m ? m[1] : null;
                            })
                            .catch(() => null);
                        console.log(
                            `[${accountLabel}] BOOKING SUCCESS! Ref: ${bookingNum || "unknown"}`,
                        );
                        return true;
                    }

                    if (outcome === "redirected") {
                        console.log(
                            `[${accountLabel}] Server redirected to an earlier step — wizard will refresh and re-detect.`,
                        );
                        return false;
                    }

                    if (outcome === "error") {
                        console.log(
                            `[${accountLabel}] Server error toast detected (attempt ${attempt}/${MAX_FINAL_RETRIES}).`,
                        );
                    } else {
                        console.log(
                            `[${accountLabel}] No outcome within window (attempt ${attempt}/${MAX_FINAL_RETRIES}).`,
                        );
                    }

                    if (attempt < MAX_FINAL_RETRIES) {
                        await new Promise((r) => setTimeout(r, 2000));
                        continue;
                    }
                    return false;
                } catch (error) {
                    console.error(
                        `[${accountLabel}] Error in final step attempt ${attempt}:`,
                        error.message,
                    );
                    if (attempt < MAX_FINAL_RETRIES) {
                        await new Promise((r) => setTimeout(r, 2000));
                        continue;
                    }
                    return false;
                }
            }

            console.log(
                `[${accountLabel}] All ${MAX_FINAL_RETRIES} final step attempts exhausted.`,
            );
            return false;
        } finally {
            await stopHelper();
        }
    },

    async clickAvanti(page) {
        try {
            console.log("Waiting for AVANTI button to be enabled...");
            await page
                .waitForFunction(
                    () =>
                        [...document.querySelectorAll("button")].find(
                            (b) =>
                                b.innerText.trim() === "AVANTI" && !b.disabled,
                        ),
                    undefined,
                    { timeout: 10000 },
                )
                .catch(() =>
                    console.log(
                        "AVANTI button wait timeout, trying anyway...",
                    ),
                );

            const clicked = await page.evaluate(() => {
                const btn = [...document.querySelectorAll("button")].find(
                    (b) => b.innerText.trim() === "AVANTI" && !b.disabled,
                );
                if (!btn) return false;
                const r = btn.getBoundingClientRect();
                ["mousedown", "mouseup", "click"].forEach((t) =>
                    btn.dispatchEvent(
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
            if (clicked)
                console.log(
                    "AVANTI button clicked successfully using extension method",
                );
            else throw new Error("AVANTI button not found or disabled");
        } catch (error) {
            console.error("AVANTI click failed:", error.message);
            throw error;
        }
    },

    async ensureCheckbox(page, { forceRecheck = false } = {}) {
        console.log(
            `Looking for final checkbox${forceRecheck ? " (force re-check)" : ""}...`,
        );

        // On retry the checkbox may already be checked but the captcha widget
        // is in a stale/submitted state — toggle off then on to remount it.
        const clicked = await page.evaluate((force) => {
            const input = document.querySelector('input[type="checkbox"]');
            if (!input) return false;

            if (force && input.checked) {
                input.click();
            }

            if (!input.checked) {
                input.click();
            }
            return input.checked;
        }, forceRecheck);

        if (!clicked) {
            throw new Error("CHECKBOX_FAILED");
        }

        console.log(`Final checkbox checked successfully`);
    },
};

module.exports = { BookingFlowMethods };
