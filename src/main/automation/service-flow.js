/**
 * Prototype methods attached to BrowserAutomation — mounted via Object.assign in index.js.
 * Owns the post-login "seleziona il servizio" page: pagination, service-row click,
 * duplicato radio, and the AVANTI that leads into the booking flow.
 *
 * Relies on sibling methods via `this`:
 *   - this.waitUntilScheduledTime   (scheduler.js)
 *   - this.completeBookingFlow      (booking-flow.js)
 */
const ServiceFlowMethods = {
    /**
     * Heading-driven entry point. The booking wizard calls this when it detects
     * the "Seleziona il servizio" heading. Single pass: wait for the list,
     * click the service, click duplicato, click AVANTI. Throws on failure so
     * the wizard retries via INDIETRO/refresh.
     */
    async handleServiceSelection(page, accountLabel, config) {
        const configPhrases = Array.isArray(config?.servicePhrases)
            ? config.servicePhrases.filter(
                  (p) => typeof p === "string" && p.trim().length > 0,
              )
            : [];

        if (configPhrases.length === 0) {
            throw new Error(
                "No service phrases configured — add phrases in the Services tab.",
            );
        }

        console.log(
            `[${accountLabel}] Service selection (phrase: "${configPhrases[0]}")...`,
        );

        // Wait for the actual heading (Vuetify <span class="display-1">).
        await this.waitForStepHeading(page, "Seleziona il servizio", 15000);

        // Wait for the service list rows to render before matching. The title
        // can appear before the rows are populated by Vue.
        await page
            .waitForFunction(
                () => {
                    const rows = document.querySelectorAll(
                        ".caselleservizi .row, [class*='caselle'] .row, .v-banner-on-hover, .v-list-item, [role='listitem'], .v-stepper__content .row, main .row",
                    );
                    return rows.length > 0;
                },
                undefined,
                { timeout: 10000 },
            )
            .catch(() =>
                console.log(
                    `[${accountLabel}] Service rows didn't render in 10s — trying match anyway`,
                ),
            );

        // Page 1 is the default — no pagination click needed. Try matching here;
        // only paginate to page 2 if the service isn't on the current page.
        let serviceClicked = await this.clickServiceByPhrases(
            page,
            configPhrases,
        );
        console.log(
            `[${accountLabel}] Service row on default page: ${serviceClicked ? "ok" : "not found"}`,
        );

        if (!serviceClicked) {
            const pagOk = await this.clickPaginationNumber(page, 2);
            console.log(
                `[${accountLabel}] Pagination 2: ${pagOk ? "ok" : "skip/fail"}`,
            );
            await page
                .waitForLoadState("domcontentloaded", { timeout: 3000 })
                .catch(() => {});
            serviceClicked = await this.clickServiceByPhrases(
                page,
                configPhrases,
            );
            console.log(
                `[${accountLabel}] Service row on page 2: ${serviceClicked ? "ok" : "not found"}`,
            );
        }

        if (!serviceClicked) {
            throw new Error("Service row not found on pages 1–2");
        }

        // After the row click, Tipologia options (incl. Duplicato) render via
        // Vue — clickDuplicato's per-locator waitFor(2s) handles that delay.
        const duplicatoClicked = await this.clickDuplicato(page);
        if (!duplicatoClicked) {
            throw new Error("Duplicato radio not found or not clickable");
        }

        const respPromise = this.waitForBackendResponse(page, 8000);
        const avantiClicked = await this.clickEnabledAvanti(page);
        if (!avantiClicked) {
            throw new Error("AVANTI still disabled after service + duplicato");
        }
        await respPromise;

        console.log(`[${accountLabel}] Service step completed (AVANTI clicked).`);
        return true;
    },

    async completeServiceFlow(page, selectedService, accountLabel, config) {
        console.log(
            `[${accountLabel}] STEP 7.1: Starting service selection flow (service=${selectedService || "?"})`,
        );

        // Wait for prenotazione page to load
        await page
            .waitForURL(/prenotazione/i, { timeout: 120000 })
            .catch(() => {});

        // Wait for service selection title
        await page
            .getByText(/seleziona il servizio/i)
            .first()
            .waitFor({ state: "visible", timeout: 60000 })
            .catch(() => {
                console.log(
                    `[${accountLabel}] Service selection title not found, continuing anyway`,
                );
            });

        // Phrases must come from user's Services config — no hardcoded fallback.
        const configPhrases = Array.isArray(config?.servicePhrases)
            ? config.servicePhrases.filter(
                  (p) => typeof p === "string" && p.trim().length > 0,
              )
            : [];

        if (configPhrases.length === 0) {
            console.log(
                `[${accountLabel}] ERROR: No service phrases configured. Cannot select service.`,
            );
            return;
        }

        console.log(
            `[${accountLabel}] Service phrase (exact match): "${configPhrases[0]}"`,
        );

        // Page 1 first, then page 2 if not found.
        const paginationOrder = [1, 2];
        const deadline = Date.now() + 120000;

        while (Date.now() < deadline) {
            const url = page.url();
            if (!url.toLowerCase().includes("prenotazione")) {
                await new Promise((resolve) => setTimeout(resolve, 100));
                continue;
            }

            let serviceClicked = false;

            for (const pNum of paginationOrder) {
                console.log(
                    `[${accountLabel}] STEP 7.2.${pNum}: Trying page ${pNum}...`,
                );
                const pagOk = await this.clickPaginationNumber(page, pNum);
                console.log(
                    `[${accountLabel}] Pagination -> ${pNum}: ${pagOk ? "ok" : "skip/fail"}`,
                );

                serviceClicked = await this.clickServiceByPhrases(
                    page,
                    configPhrases,
                );
                console.log(
                    `[${accountLabel}] Service row click on page ${pNum}: ${serviceClicked ? "ok" : "not found"}`,
                );
                if (serviceClicked) break;
            }

            if (!serviceClicked) {
                continue;
            }

            try {
                await page
                    .waitForLoadState("domcontentloaded", { timeout: 3000 })
                    .catch(() => {});
            } catch {
                // Continue even if wait fails
            }

            console.log(
                `[${accountLabel}] STEP 7.4: Clicking duplicato radio button...`,
            );
            const duplicatoClicked = await this.clickDuplicato(page);
            console.log(
                `[${accountLabel}] Duplicato: ${duplicatoClicked ? "ok" : "fail"}`,
            );
            if (!duplicatoClicked) {
                continue;
            }

            console.log(
                `[${accountLabel}] STEP 7.5: Clicking AVANTI button to proceed...`,
            );
            const avantiClicked = await this.clickEnabledAvanti(page);
            console.log(
                `[${accountLabel}] Avanti: ${avantiClicked ? "ok" : "still disabled / fail"}`,
            );
            if (avantiClicked) {
                console.log(
                    `[${accountLabel}] Service selection completed - Starting booking flow...`,
                );

                await this.waitUntilScheduledTime(config, accountLabel);
                if (this.stopFlag) return;

                await this.completeBookingFlow(page, accountLabel, config);
                return;
            }
        }

        console.log(
            `[${accountLabel}] Service flow not completed within timeout`,
        );
    },

    async clickPaginationNumber(page, number) {
        const n = String(number);
        const label = new RegExp(`^\\s*${n}\\s*$`);

        const scopedRoots = [
            page.locator(".v-pagination").first(),
            page.locator(".col.text-center").filter({ hasText: /\b1\b|\b2\b/ }),
        ];

        for (const root of scopedRoots) {
            try {
                const btn = root
                    .locator("button, a.v-btn, .v-btn")
                    .filter({ hasText: label })
                    .first();
                await btn.waitFor({ state: "visible", timeout: 3000 });
                await btn.scrollIntoViewIfNeeded().catch(() => {});
                await btn.click({ force: true });
                return true;
            } catch {
                /* next root */
            }
        }

        return await page.evaluate((num) => {
            const wanted = String(num);
            const roots = Array.from(
                document.querySelectorAll(".v-pagination, .col.text-center"),
            );
            for (const root of roots) {
                const buttons = Array.from(
                    root.querySelectorAll("button, a.v-btn, .v-btn"),
                );
                for (const b of buttons) {
                    const t = (b.textContent || "").replace(/\s+/g, " ").trim();
                    if (t !== wanted) continue;
                    b.dispatchEvent(
                        new MouseEvent("click", {
                            bubbles: true,
                            cancelable: true,
                            view: window,
                        }),
                    );
                    return true;
                }
            }
            return false;
        }, n);
    },

    // Exact full-text match only — no partial/substring/fallback matching.
    async clickServiceByPhrases(page, phrases) {
        const clicked = await page.evaluate((rawPhrases) => {
            const norm = (s) =>
                (s || "").toLowerCase().replace(/\s+/g, " ").trim();
            const phraseList = rawPhrases.map(norm).filter((p) => p.length > 0);

            const rowSelectors = [
                ".caselleservizi .row",
                "[class*='caselle'] .row",
                ".v-banner-on-hover",
                ".v-list-item",
                "[role='listitem']",
                ".v-stepper__content .row",
                "main .row",
            ];

            const seen = new Set();
            const rows = [];
            for (const sel of rowSelectors) {
                document.querySelectorAll(sel).forEach((el) => {
                    if (!seen.has(el)) {
                        seen.add(el);
                        rows.push(el);
                    }
                });
            }

            for (const row of rows) {
                const t = norm(row.innerText || row.textContent || "");
                if (t.length < 5) continue;
                // Row innerText includes button/icon text alongside service name.
                // Use word-boundary-aware check: phrase must appear as a standalone
                // block (not as a substring of a longer word run).
                const matched = phraseList.some((p) => {
                    if (!t.includes(p)) return false;
                    const idx = t.indexOf(p);
                    const before = idx === 0 ? "" : t[idx - 1];
                    const after = idx + p.length >= t.length ? "" : t[idx + p.length];
                    const edgeBefore = before === "" || /[\s,.()\-]/.test(before);
                    const edgeAfter = after === "" || /[\s,.()\-]/.test(after);
                    return edgeBefore && edgeAfter;
                });
                if (!matched) continue;

                const clickable = row.querySelector(
                    "button, .v-btn, a.v-btn, [role='button']",
                );
                const target = clickable || row;
                target.dispatchEvent(
                    new MouseEvent("click", {
                        bubbles: true,
                        cancelable: true,
                        view: window,
                    }),
                );
                return true;
            }
            return false;
        }, phrases);
        return clicked;
    },

    async clickDuplicato(page) {
        const playwrightTries = [
            // The current UI wraps the whole Duplicato choice in a <button>
            // with an inner <label class="form-control">. Click the wrapping
            // button so Vue's click handler fires reliably.
            async () => {
                const btn = page
                    .locator("button")
                    .filter({ hasText: /^\s*duplicato\s*$/i })
                    .first();
                await btn.waitFor({ state: "visible", timeout: 3000 });
                await btn.click({ force: true, timeout: 2000 });
                return true;
            },
            async () => {
                await page
                    .getByRole("radio", { name: /^duplicato$/i })
                    .click({ force: true, timeout: 2000 });
                return true;
            },
            async () => {
                await page
                    .getByRole("radio", { name: /duplicato/i })
                    .first()
                    .click({ force: true, timeout: 2000 });
                return true;
            },
            async () => {
                const lab = page
                    .locator("label.form-control, label")
                    .filter({ hasText: /^\s*duplicato\s*$/i })
                    .first();
                await lab.waitFor({ state: "visible", timeout: 2000 });
                await lab.click({ force: true, timeout: 2000 });
                return true;
            },
            async () => {
                const group = page
                    .locator(".input-group-text, .input-group")
                    .filter({ hasText: /^\s*duplicato\s*$/i })
                    .first();
                await group.waitFor({ state: "visible", timeout: 2000 });
                const r = group
                    .locator('input[type="radio"][name="tipologia"]')
                    .first();
                await r.click({ force: true, timeout: 2000 });
                return true;
            },
        ];

        for (const fn of playwrightTries) {
            try {
                if (await fn()) return true;
            } catch {
                /* next */
            }
        }

        const domOk = await page.evaluate(() => {
            const norm = (s) =>
                (s || "").replace(/\s+/g, " ").trim().toLowerCase();

            const fireRadio = (input) => {
                input.focus();
                input.checked = true;
                input.dispatchEvent(new Event("input", { bubbles: true }));
                input.dispatchEvent(new Event("change", { bubbles: true }));
                input.click();
            };

            const labels = Array.from(document.querySelectorAll("label"));
            for (const label of labels) {
                if (norm(label.textContent) !== "duplicato") continue;
                const forId = label.getAttribute("for");
                if (forId) {
                    const inp = document.getElementById(forId);
                    if (inp?.name === "tipologia" && inp.type === "radio") {
                        fireRadio(inp);
                        return true;
                    }
                }
                const inner = label.querySelector(
                    'input[type="radio"][name="tipologia"]',
                );
                if (inner) {
                    fireRadio(inner);
                    return true;
                }
            }

            for (const input of document.querySelectorAll(
                'input[type="radio"][name="tipologia"]',
            )) {
                const wrap =
                    input.closest(".input-group-text") ||
                    input.closest(".input-group") ||
                    input.parentElement;
                const labelEl =
                    wrap?.querySelector("label") || input.nextElementSibling;
                const labelText = norm(labelEl?.textContent || "");
                if (labelText === "duplicato") {
                    fireRadio(input);
                    return true;
                }
            }
            return false;
        });
        return domOk;
    },

    async clickEnabledAvanti(page) {
        // 1. Wait (raf polling, default) for an AVANTI button to be present
        //    AND not in any disabled state. Wakes within one frame of change.
        try {
            await page.waitForFunction(
                () => {
                    const norm = (s) =>
                        (s || "")
                            .toLowerCase()
                            .replace(/\s+/g, " ")
                            .trim();
                    const nodes = Array.from(
                        document.querySelectorAll(
                            "button, a, .v-btn, .btn, input[type='button'], input[type='submit']",
                        ),
                    );
                    const avanti = nodes.find((el) =>
                        norm(el.textContent || el.value || "").includes(
                            "avanti",
                        ),
                    );
                    if (!avanti) return false;
                    const disabled =
                        avanti.disabled ||
                        avanti.classList.contains("v-btn--disabled") ||
                        avanti.getAttribute("aria-disabled") === "true";
                    return !disabled;
                },
                undefined,
                { timeout: 15000 },
            );
        } catch {
            return false;
        }

        // 2. Click via Playwright's real-mouse pipeline so isTrusted=true.
        //    Vuetify v-btn rejects synthetic dispatched events, which would
        //    silently no-op even though we logged "clicked".
        try {
            const btn = page
                .locator(
                    "button, a, .v-btn, .btn, input[type='button'], input[type='submit']",
                )
                .filter({ hasText: /avanti/i })
                .first();
            await btn.scrollIntoViewIfNeeded().catch(() => {});
            await btn.click({ timeout: 5000 });
            return true;
        } catch {
            return false;
        }
    },
};

module.exports = { ServiceFlowMethods };
