/**
 * CapSolver API key panel — key is stored in data/capsolver-settings.json and
 * synced into the unpacked extension's assets/config.js on save.
 */
export const CapsolverUiMethods = {
    refreshCapsolverForm() {
        const input = document.getElementById("storedCapsolverApiKey");
        const status = document.getElementById("capsolverKeyStatus");
        if (input) {
            input.value = this.capsolverSettings?.apiKey ?? "";
        }
        if (status) {
            const has = Boolean((this.capsolverSettings?.apiKey || "").trim());
            status.textContent = has
                ? "API key saved and synced to the CapSolver extension."
                : "No API key saved yet.";
        }
    },

    async saveCapsolverSettingsFromUI() {
        const input = document.getElementById("storedCapsolverApiKey");
        const apiKey = (input?.value ?? "").trim();
        if (!apiKey) {
            this.showNotification("Enter a CapSolver API key", "error");
            return;
        }

        this.capsolverSettings = {
            apiKey,
            chromiumExtensionPath:
                this.capsolverSettings?.chromiumExtensionPath || "",
            useChromeChannel: Boolean(this.capsolverSettings?.useChromeChannel),
        };

        try {
            const result = await window.electronAPI.saveCapsolverSettings(
                this.capsolverSettings,
            );
            if (!result.success) {
                throw new Error(result.error || "Save failed");
            }
            this.refreshCapsolverForm();
            this.showNotification("CapSolver API key saved", "success");
        } catch (error) {
            console.error("Save CapSolver settings:", error);
            this.showNotification(
                "Could not save API key: " + error.message,
                "error",
            );
        }
    },

    async clearCapsolverSettingsFromUI() {
        if (
            !confirm(
                "Remove the saved CapSolver API key from this computer?",
            )
        ) {
            return;
        }

        this.capsolverSettings = {
            apiKey: "",
            chromiumExtensionPath:
                this.capsolverSettings?.chromiumExtensionPath || "",
            useChromeChannel: Boolean(this.capsolverSettings?.useChromeChannel),
        };
        const input = document.getElementById("storedCapsolverApiKey");
        if (input) input.value = "";

        try {
            const result = await window.electronAPI.saveCapsolverSettings(
                this.capsolverSettings,
            );
            if (!result.success) {
                throw new Error(result.error || "Save failed");
            }
            this.refreshCapsolverForm();
            this.showNotification("CapSolver API key cleared", "success");
        } catch (error) {
            console.error("Clear CapSolver settings:", error);
            this.showNotification(
                "Could not clear API key: " + error.message,
                "error",
            );
        }
    },
};
