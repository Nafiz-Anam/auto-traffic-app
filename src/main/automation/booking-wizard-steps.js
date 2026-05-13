/** Booking wizard steps in display order (service → summary). */
const WIZARD_STEPS = [
    { id: "service", heading: "Seleziona il servizio" },
    { id: "structure", heading: "Seleziona la struttura" },
    { id: "date", heading: "Seleziona la data" },
    { id: "additional", heading: "Informazioni aggiuntive" },
    { id: "summary", heading: "Riepilogo richiesta" },
];

const STEP_ORDER = Object.fromEntries(
    WIZARD_STEPS.map((step, index) => [step.id, index]),
);

const HEADING_SELECTOR =
    "h1, h2, h3, h4, .v-card-title, .v-toolbar-title, [class*='title']";

/**
 * Detect which wizard step the page is on from visible headings, then body text.
 * @returns {Promise<string|null>} step id or null
 */
async function detectWizardStep(page) {
    return page.evaluate(
        ({ steps, headingSelector }) => {
            const norm = (s) =>
                (s || "").toLowerCase().replace(/\s+/g, " ").trim();

            const headingTexts = [
                ...document.querySelectorAll(headingSelector),
            ]
                .map((el) => norm(el.innerText || el.textContent || ""))
                .filter((t) => t.length > 0);

            const body = norm(document.body.innerText || document.body.textContent || "");

            const matches = (needle) => {
                const n = norm(needle);
                if (headingTexts.some((h) => h.includes(n))) return true;
                return body.includes(n);
            };

            // Most specific / latest steps first so partial overlaps cannot win.
            for (let i = steps.length - 1; i >= 0; i--) {
                if (matches(steps[i].heading)) return steps[i].id;
            }
            return null;
        },
        { steps: WIZARD_STEPS, headingSelector: HEADING_SELECTOR },
    );
}

/**
 * Poll until a wizard step is detected or timeout.
 * @returns {Promise<string|null>}
 */
async function waitForWizardStep(page, timeoutMs = 15000) {
    try {
        const handle = await page.waitForFunction(
            ({ steps, headingSelector }) => {
                const norm = (s) =>
                    (s || "").toLowerCase().replace(/\s+/g, " ").trim();

                const headingTexts = [
                    ...document.querySelectorAll(headingSelector),
                ]
                    .map((el) => norm(el.innerText || el.textContent || ""))
                    .filter((t) => t.length > 0);

                const body = norm(
                    document.body.innerText || document.body.textContent || "",
                );

                const matches = (needle) => {
                    const n = norm(needle);
                    if (headingTexts.some((h) => h.includes(n))) return true;
                    return body.includes(n);
                };

                for (let i = steps.length - 1; i >= 0; i--) {
                    if (matches(steps[i].heading)) return steps[i].id;
                }
                return null;
            },
            { steps: WIZARD_STEPS, headingSelector: HEADING_SELECTOR },
            { timeout: timeoutMs, polling: 100 },
        );
        return await handle.jsonValue();
    } catch {
        return null;
    }
}

module.exports = {
    WIZARD_STEPS,
    STEP_ORDER,
    detectWizardStep,
    waitForWizardStep,
};
