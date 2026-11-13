(function () {
    const saveConfigBtn = document.getElementById("save-config-btn") as HTMLButtonElement;
    const versionSelector = document.getElementById("version-selector") as HTMLSelectElement;
    const accessTokenInput = document.getElementById("access-token-input") as HTMLInputElement;
    const proxySection = document.getElementById("proxy-section") as HTMLElement;
    const proxySelector = document.getElementById("proxy-selector") as HTMLSelectElement;

    const hostURL = "https://falcon-loader.onrender.com";

    let cachedSettings = "";
    const NO_PROXY = "none";

    const settings: SettingsSchema = {
        accessToken: "",
        versionSelection: "latest",
        proxyId: NO_PROXY
    };

    interface SettingsSchema {
        accessToken?: string;
        versionSelection?: string;
        proxyId?: string;
        proxyConfig?: ProxyEntry;
    }

    interface ProxyEntry {
        id: string;
        kind: "paid" | "static" | "direct";
        label: string;
        host: string;
        port: number;
        username: string;
        password: string;
    }
    
    let proxyList: ProxyEntry[] = [];
    type Fingerprint = Record<"gpu" | "webgpu" | "cores" | "memory" | "timezone" | "language" | "screen", string>;
    async function shortHash(text: string) {
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
        return Array.from(new Uint8Array(digest).slice(0, 8))
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
    }

    function readGpu() {
        try {
            const canvas = document.createElement("canvas");
            const gl = (canvas.getContext("webgl") || canvas.getContext("experimental-webgl")) as WebGLRenderingContext | null;
            if (!gl) return "none";

            const info = gl.getExtension("WEBGL_debug_renderer_info");
            if (!info) return "unknown";

            return `${gl.getParameter(info.UNMASKED_VENDOR_WEBGL)}|${gl.getParameter(info.UNMASKED_RENDERER_WEBGL)}`;
        } catch {
            return "error";
        }
    }

    async function readWebGpu() {
        try {
            const gpu = (navigator as any).gpu;
            if (!gpu) return "none";

            const adapter = await gpu.requestAdapter();
            if (!adapter) return "none";

            // older chrome uses requestAdapterInfo
            const info = adapter.info ?? (await adapter.requestAdapterInfo?.());
            if (!info) return "unknown";

            return [info.vendor, info.architecture, info.device, info.description].join("|");
        } catch {
            return "error";
        }
    }

    async function collectFingerprint(): Promise<Fingerprint> {
        const raw = {
            gpu: readGpu(),
            webgpu: await readWebGpu(),
            cores: String(navigator.hardwareConcurrency ?? "unknown"),
            memory: String((navigator as any).deviceMemory ?? "unknown"),
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "unknown",
            language: navigator.language ?? "unknown",
            screen: `${screen.width}x${screen.height}`
        };

        const entries = await Promise.all(
            Object.entries(raw).map(async ([key, value]) => [key, await shortHash(value)] as const)
        );

        return Object.fromEntries(entries) as Fingerprint;
    }

    saveConfigBtn.onclick = async (ev) => {
        if (!ev.isTrusted) return;

        const { versionSelection, accessToken, proxyId } = settings;
        await chrome.storage.local.set({ versionSelection, accessToken });
        if (proxyList.length > 0) {
            const chosen = proxyList.find((proxy) => proxy.id === proxyId);
            if (chosen) await chrome.storage.local.set({ proxyConfig: chosen });
            else await chrome.storage.local.remove("proxyConfig");
        }
        cachedSettings = JSON.stringify(settings);
        saveConfigBtn.blur();
        loadProxies();
    };

    accessTokenInput.oninput = (ev) => {
        if (!ev.isTrusted) return;
        settings.accessToken = accessTokenInput.value;
    };

    versionSelector.oninput = (ev) => {
        if (!ev.isTrusted) return;
        settings.versionSelection = versionSelector.value;
    };

    proxySelector.oninput = (ev) => {
        if (!ev.isTrusted) return;
        settings.proxyId = proxySelector.value;
    };

    function resetProxy() {
        settings.proxyId = NO_PROXY;

        try {
            cachedSettings = JSON.stringify({ ...JSON.parse(cachedSettings), proxyId: NO_PROXY });
        } catch { }

        chrome.storage.local.remove("proxyConfig");
    }

    function hideProxies() {
        proxyList = [];
        proxySection.hidden = true;
    }

    function renderProxies() {
        proxySelector.replaceChildren();

        const none = document.createElement("option");
        none.value = NO_PROXY;
        none.textContent = "No Proxy";
        proxySelector.append(none);

        const groups: [ProxyEntry["kind"], string][] = [
            ["paid", "paid proxies"],
            ["static", "proxies that work without account"],
            ["direct", "free webshare proxies and oxylabs proxies"]
        ];

        for (const [kind, title] of groups) {
            const entries = proxyList.filter((proxy) => proxy.kind === kind);
            if (entries.length === 0) continue;

            const group = document.createElement("optgroup");
            group.label = title;

            for (const proxy of entries) {
                const option = document.createElement("option");
                option.value = proxy.id;
                option.textContent = proxy.label;
                group.append(option);
            }

            proxySelector.append(group);
        }
        if (settings.proxyId !== NO_PROXY && !proxyList.some((proxy) => proxy.id === settings.proxyId)) {
            resetProxy();
        }
        proxySelector.value = settings.proxyId ?? NO_PROXY;
        proxySection.hidden = false;
    }

    async function loadProxies() {
        const token = settings.accessToken ?? "";

        if (!token) {
            hideProxies();
            return resetProxy();
        }

        try {
            const res = await fetch(`${hostURL}/proxies`, {
                headers: { authorization: `Bearer ${token}` }
            });

            // bad token or not allowed to use proxies
            if (res.status === 401 || res.status === 403) {
                hideProxies();
                return resetProxy();
            }

            if (!res.ok) return hideProxies();

            const data = (await res.json()) as { proxies?: ProxyEntry[] };
            proxyList = data.proxies ?? [];

            if (proxyList.length === 0) return hideProxies();
            renderProxies();
        } catch {
            hideProxies();
        }
    }

    interface ScriptVersions {
        latest: string;
        versions: Record<string, string>;
    }

    async function updateVersions() {
        try {
            // token lets the server show the dev build to dev tokens
            const res = await fetch(`${hostURL}/versions.json`, {
                headers: { authorization: `Bearer ${settings.accessToken ?? ""}` }
            });
            const data = (await res.json()) as ScriptVersions;

            versionSelector.innerHTML = "";

            for (const key in data.versions) {
                const val = data.versions[key];

                versionSelector.innerHTML = `
                <option value=${data.versions[key]} ${val === settings.versionSelection ? "selected" : ""}>
                    ${key}
                </option>
            `+ versionSelector.innerHTML;
            }

            versionSelector.innerHTML = `<option value="latest" ${settings.versionSelection === "latest" ? "selected" : ""}>Latest Version</option>` + versionSelector.innerHTML;

            versionSelector.innerHTML += `<option value="none" ${settings.versionSelection === "none" ? "selected" : ""}>No Mod (basically just here so you can bypass ban while legit or with macros)</option>`;
        } catch (e) { }
    }

    chrome.storage.local.get(["accessToken", "versionSelection", "proxyConfig"], (result: SettingsSchema) => {
        const accessToken = result.accessToken ?? "";
        const versionSelection = result.versionSelection ?? "latest";

        accessTokenInput.value = accessToken;

        settings.accessToken = accessToken;
        settings.versionSelection = versionSelection;
        settings.proxyId = result.proxyConfig?.id ?? NO_PROXY;

        if (versionSelection !== "latest") {
            versionSelector.innerHTML = `<option>Loading...</option>`;
        }

        cachedSettings = JSON.stringify(settings);
        chrome.storage.local.set({ accessToken, versionSelection });
        updateVersions();
        loadProxies();
    });

    collectFingerprint()
        .then((fingerprint) => chrome.storage.local.set({ fingerprint }))
        .catch(() => { });

    function updateSaveBtn() {
        if (JSON.stringify(settings) === cachedSettings) {
            saveConfigBtn.classList.add("disabled");
        } else {
            saveConfigBtn.classList.remove("disabled");
        }

        window.requestAnimationFrame(updateSaveBtn);
    }

    const ERROR_MESSAGES: Record<string, string> = {
        invalid_access_token: "Token invalid",
        device_limit: "This token is already registered on the maximum number of devices. (if this is a mistake message me on discord)",
        missing_fingerprint: "Device info is missing. Reload this page and try again.",
        server_error: "The server returned an error.",
        server_unreachable: "Couldn't reach the falcon loader server."
    };

    document.addEventListener("DOMContentLoaded", () => {
        const urlParams = new URLSearchParams(window.location.search);
        const error = urlParams.get("error");

        if (error) {
            alert(ERROR_MESSAGES[error] ?? error);
        }
    });

    window.requestAnimationFrame(updateSaveBtn);
})();