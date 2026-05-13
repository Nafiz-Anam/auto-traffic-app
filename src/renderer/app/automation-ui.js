/**
 * Dashboard automation controls: pre-start validation, config assembly,
 * start/stop IPC calls, status-bar updates, and the running-status poller.
 */
export const AutomationUiMethods = {
    async startAutomation() {
        if (this.isRunning) {
            this.showNotification("Automation is already running", "warning");
            return;
        }

        if (this.accounts.length === 0) {
            this.showNotification("Please add at least one account", "error");
            return;
        }

        if (this.services.length === 0) {
            this.showNotification(
                "Please add at least one service in the Services tab",
                "error",
            );
            return;
        }

        const selectedServiceName =
            document.getElementById("serviceSelect").value;
        if (
            !selectedServiceName ||
            !this.services.some((s) => s.name === selectedServiceName)
        ) {
            this.showNotification("Please select a valid service", "error");
            return;
        }

        const useProxy = document.getElementById("useProxy")?.checked !== false;

        if (useProxy && this.proxies.length === 0) {
            this.showNotification("Please add at least one proxy", "error");
            return;
        }

        const windowCount =
            parseInt(document.getElementById("windowCount").value) || 1;

        if (windowCount < 1 || windowCount > 20) {
            this.showNotification(
                "Window count must be between 1 and 20",
                "error",
            );
            return;
        }

        if (windowCount > this.accounts.length) {
            this.showNotification(
                `Not enough accounts for ${windowCount} windows (available: ${this.accounts.length})`,
                "error",
            );
            return;
        }

        if (useProxy) {
            const expandedProxyCount = this.proxies.reduce(
                (sum, p) =>
                    sum + Math.max(parseInt(p.portRange, 10) || 1, 1),
                0,
            );
            if (windowCount > expandedProxyCount) {
                this.showNotification(
                    `Not enough proxies for ${windowCount} windows (available: ${expandedProxyCount})`,
                    "error",
                );
                return;
            }
        }

        const config = this.getAutomationConfig();

        try {
            const result = await window.electronAPI.startAutomation(config);

            if (result && result.success) {
                this.isRunning = true;
                this.updateControlButtons();
                this.updateStatus("running", "Automation Running");
                this.showNotification(
                    "Automation started successfully",
                    "success",
                );
            } else if (result && !result.success) {
                this.showNotification(
                    result.error || "Failed to start automation",
                    "error",
                );
            } else {
                // result is undefined but automation may still be running
                console.log(
                    "Start automation returned undefined, checking status...",
                );
                this.isRunning = true;
                this.updateControlButtons();
                this.updateStatus("running", "Automation Running");
            }
        } catch (error) {
            console.error("Start automation error:", error.message);
            console.error("Stack:", error.stack);
            this.showNotification(
                "Failed to start automation: " + error.message,
                "error",
            );
        }
    },

    async stopAutomation() {
        if (!this.isRunning) {
            return;
        }

        try {
            const result = await window.electronAPI.stopAutomation();

            if (result.success) {
                this.isRunning = false;
                this.updateControlButtons();
                this.updateStatus("ready", "Ready");
                this.showNotification(
                    "Automation stopped successfully",
                    "success",
                );
            } else {
                this.showNotification(
                    result.error || "Failed to stop automation",
                    "error",
                );
            }
        } catch (error) {
            console.error("Stop automation error:", error);
            this.showNotification("Failed to stop automation", "error");
        }
    },

    getAutomationConfig() {
        const service = document.getElementById("serviceSelect").value;
        const selectedService = this.services.find(
            (s) => s.name === service,
        );
        // Use service name as the exact match text.
        // If phrases are configured, use them as override; otherwise fall back to name.
        const servicePhrases = selectedService
            ? (selectedService.phrases && selectedService.phrases.length > 0
                ? [...selectedService.phrases]
                : [selectedService.name])
            : [];
        const timerMode = document.querySelector(
            'input[name="timer"]:checked',
        ).value;
        const windowCount =
            parseInt(document.getElementById("windowCount").value) || 1;

        const useProxy =
            document.getElementById("useProxy")?.checked !== false;

        const config = {
            service,
            servicePhrases,
            timerMode,
            windowCount,
            useProxy,
        };

        if (timerMode === "scheduled") {
            const hour = parseInt(
                document.getElementById("hourInput").value,
                10,
            );
            const minute = parseInt(
                document.getElementById("minuteInput").value,
                10,
            );
            const second = parseInt(
                document.getElementById("secondInput").value,
                10,
            );
            config.scheduledTime = {
                hour: Number.isFinite(hour) ? hour : 0,
                minute: Number.isFinite(minute) ? minute : 0,
                second: Number.isFinite(second) ? second : 0,
            };
        }

        console.log("Automation config:", config);

        return config;
    },

    updateControlButtons() {
        const startBtn = document.getElementById("startBtn");
        const stopBtn = document.getElementById("stopBtn");

        if (startBtn) startBtn.disabled = this.isRunning;
        if (stopBtn) stopBtn.disabled = !this.isRunning;
    },

    updateStatus(status, text) {
        const indicator = document.getElementById("statusIndicator");
        const dot = indicator.querySelector(".status-dot");
        const textElement = indicator.querySelector(".status-text");

        dot.className = `status-dot ${status}`;
        textElement.textContent = text;
    },

    startClock() {
        const clockEl = document.getElementById("clockDisplay");
        const countdownEl = document.getElementById("countdownDisplay");
        const countdownContainer = document.getElementById("timeCountdown");

        const tick = () => {
            const now = new Date();
            const pad = (n) => String(n).padStart(2, "0");
            if (clockEl) {
                clockEl.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
            }

            const isScheduled =
                document.querySelector('input[name="timer"]:checked')
                    ?.value === "scheduled";

            if (countdownContainer && countdownEl) {
                if (isScheduled) {
                    const tH = parseInt(
                        document.getElementById("hourInput")?.value,
                        10,
                    );
                    const tM = parseInt(
                        document.getElementById("minuteInput")?.value,
                        10,
                    );
                    const tS = parseInt(
                        document.getElementById("secondInput")?.value,
                        10,
                    );

                    if (
                        Number.isFinite(tH) &&
                        Number.isFinite(tM) &&
                        Number.isFinite(tS)
                    ) {
                        const target = new Date();
                        target.setHours(tH, tM, tS, 0);

                        const diffS = Math.max(
                            0,
                            Math.floor((target - now) / 1000),
                        );
                        const rh = Math.floor(diffS / 3600);
                        const rm = Math.floor((diffS % 3600) / 60);
                        const rs = diffS % 60;
                        countdownEl.textContent = `${pad(rh)}:${pad(rm)}:${pad(rs)}`;
                        countdownContainer.style.display = "flex";
                    } else {
                        countdownContainer.style.display = "none";
                    }
                } else {
                    countdownContainer.style.display = "none";
                }
            }
        };

        tick();
        this.clockInterval = setInterval(tick, 1000);
    },

    startStatusMonitoring() {
        this.statusUpdateInterval = setInterval(async () => {
            try {
                const status = await window.electronAPI.getAutomationStatus();
                document.getElementById("activeBrowsers").textContent =
                    status.count || 0;

                if (status.running && !this.isRunning) {
                    this.isRunning = true;
                    this.updateControlButtons();
                    this.updateStatus("running", "Automation Running");
                } else if (!status.running && this.isRunning) {
                    this.isRunning = false;
                    this.updateControlButtons();
                    this.updateStatus("ready", "Ready");
                }
            } catch (error) {
                console.error("Status update error:", error);
            }
        }, 2000);
    },
};
