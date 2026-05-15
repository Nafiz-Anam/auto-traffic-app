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

// Vuetify renders the wizard step title as `<span class="display-1">`, not a
// real heading tag. Include the Vuetify typography classes so detection works.
const HEADING_SELECTOR =
    "h1, h2, h3, h4, h5, h6, " +
    ".display-1, .display-2, .display-3, .display-4, " +
    ".text-h1, .text-h2, .text-h3, .text-h4, .text-h5, .text-h6, " +
    ".headline, .v-card-title, .v-card__title, " +
    ".v-toolbar-title, .v-toolbar__title, [class*='title']";

/**
 * Detect which wizard step the page is on from visible headings, then body text.
 * @returns {Promise<string|null>} step id or null
 */
async function detectWizardStep(page) {
    return page.evaluate(
        ({ steps, headingSelector }) => {
            const norm = (s) =>
                (s || "").toLowerCase().replace(/\s+/g, " ").trim();

            // Only consider visible heading elements. Body text contains
            // stepper labels, footer links, hidden Vue labels, etc. — those
            // produced false matches (e.g. "additional" on the service page).
            const isVisible = (el) => {
                const s = window.getComputedStyle(el);
                if (
                    s.display === "none" ||
                    s.visibility === "hidden" ||
                    s.opacity === "0"
                ) {
                    return false;
                }
                const r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
            };

            const headingTexts = [
                ...document.querySelectorAll(headingSelector),
            ]
                .filter(isVisible)
                .map((el) => norm(el.innerText || el.textContent || ""))
                .filter((t) => t.length > 0);

            // Most specific / latest steps first so partial overlaps cannot win.
            for (let i = steps.length - 1; i >= 0; i--) {
                const n = norm(steps[i].heading);
                if (headingTexts.some((h) => h.includes(n))) {
                    return steps[i].id;
                }
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

                const isVisible = (el) => {
                    const s = window.getComputedStyle(el);
                    if (
                        s.display === "none" ||
                        s.visibility === "hidden" ||
                        s.opacity === "0"
                    ) {
                        return false;
                    }
                    const r = el.getBoundingClientRect();
                    return r.width > 0 && r.height > 0;
                };

                const headingTexts = [
                    ...document.querySelectorAll(headingSelector),
                ]
                    .filter(isVisible)
                    .map((el) => norm(el.innerText || el.textContent || ""))
                    .filter((t) => t.length > 0);

                for (let i = steps.length - 1; i >= 0; i--) {
                    const n = norm(steps[i].heading);
                    if (headingTexts.some((h) => h.includes(n))) {
                        return steps[i].id;
                    }
                }
                return null;
            },
            { steps: WIZARD_STEPS, headingSelector: HEADING_SELECTOR },
            { timeout: timeoutMs },
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
