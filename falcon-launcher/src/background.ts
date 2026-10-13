/// <reference types="@crxjs/vite-plugin/client" />
// iife so it's a plain sync script and not the async loader
import removeScriptFile from "./remove.js?script&iife";

(function () {
    const baseURL = "https://falcon-loader.onrender.com";

    async function registerCspBypassRule() {
        const RULE_ID = 9999;

        const rule: chrome.declarativeNetRequest.Rule = {
            id: RULE_ID,
            priority: 1,
            action: {
                type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
                responseHeaders: [
                    {
                        header: "content-security-policy",
                        operation: chrome.declarativeNetRequest.HeaderOperation.REMOVE
                    }
                ]
            },
            condition: {
                // includes subdomains
                urlFilter: "||moomoo.io/",
                resourceTypes: [
                    chrome.declarativeNetRequest.ResourceType.MAIN_FRAME,
                    chrome.declarativeNetRequest.ResourceType.SUB_FRAME
                ]
            }
        };

        await chrome.declarativeNetRequest.updateDynamicRules({
            removeRuleIds: [RULE_ID],
            addRules: [rule]
        });
    }

    interface ProxyConfig {
        id: string;
        host: string;
        port: number;
        username: string;
        password: string;
    }

    const PROXIED_DOMAINS = ["moomoo.io", "challenges.cloudflare.com", "crucible.frvr.com", "coeus.frvr.com"];
    const AUTH_FILTER = { urls: ["*://*.moomoo.io/*", "https://challenges.cloudflare.com/*"] };

    function isProxyConfig(value: any): value is ProxyConfig {
        if (!value) return false;
        if (typeof value.host !== "string" || !/^[A-Za-z0-9.-]+$/.test(value.host)) return false;
        if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) return false;
        return typeof value.username === "string" && typeof value.password === "string";
    }

    function buildPacScript(proxy: ProxyConfig) {
        const matches = PROXIED_DOMAINS
            .map((domain) => `host === "${domain}" || dnsDomainIs(host, ".${domain}")`)
            .join(" || ");

        // no DIRECT fallback so a dead proxy fails instead of leaking your ip
        return `function FindProxyForURL(url, host) {
            if (${matches}) return "PROXY ${proxy.host}:${proxy.port}";
            return "DIRECT";
        }`;
    }

    async function applyProxy() {
        const { proxyConfig } = await chrome.storage.local.get("proxyConfig");

        if (!isProxyConfig(proxyConfig)) {
            await chrome.proxy.settings.clear({ scope: "regular" });
            return;
        }

        await chrome.proxy.settings.set({
            scope: "regular",
            value: {
                mode: "pac_script",
                pacScript: { data: buildPacScript(proxyConfig) }
            }
        });
    }

    // requests we already sent credentials for, so a rejected login gets cancelled instead of retrying forever
    const answeredAuthRequests = new Set<string>();

    chrome.webRequest.onAuthRequired.addListener((details, respond): undefined => {
        if (!details.isProxy) {
            respond?.({});
            return;
        }

        chrome.storage.local.get("proxyConfig", ({ proxyConfig }) => {
            if (!isProxyConfig(proxyConfig) || details.challenger.host !== proxyConfig.host) return respond?.({});
            if (answeredAuthRequests.has(details.requestId)) return respond?.({ cancel: true });

            answeredAuthRequests.add(details.requestId);
            respond?.({ authCredentials: { username: proxyConfig.username, password: proxyConfig.password } });
        });
    }, AUTH_FILTER, ["asyncBlocking"]);

    const forgetAuthRequest = (details: { requestId: string }) => answeredAuthRequests.delete(details.requestId);
    chrome.webRequest.onCompleted.addListener(forgetAuthRequest, AUTH_FILTER);
    chrome.webRequest.onErrorOccurred.addListener(forgetAuthRequest, AUTH_FILTER);

    // remove.js is registered here instead of in the manifest so it doesn't have to wait on storage at document_start
    const REMOVE_SCRIPT_ID = "falcon-remove-official-scripts";
    const REMOVE_SCRIPT_MATCHES = ["*://moomoo.io/*", "*://*.moomoo.io/*"];
    let removeScriptSync: Promise<void> = Promise.resolve();

    async function syncRemoveScript() {
        const { versionSelection } = await chrome.storage.local.get("versionSelection");
        const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [REMOVE_SCRIPT_ID] });

        // no mod mode
        if (versionSelection === "none") {
            if (registered.length) await chrome.scripting.unregisterContentScripts({ ids: [REMOVE_SCRIPT_ID] });
            return;
        }

        // already up to date
        if (registered.length
            && registered[0].js?.[0] === removeScriptFile
            && JSON.stringify(registered[0].matches) === JSON.stringify(REMOVE_SCRIPT_MATCHES)) return;

        if (registered.length) await chrome.scripting.unregisterContentScripts({ ids: [REMOVE_SCRIPT_ID] });

        await chrome.scripting.registerContentScripts([{
            id: REMOVE_SCRIPT_ID,
            js: [removeScriptFile],
            matches: REMOVE_SCRIPT_MATCHES,
            runAt: "document_start",
            allFrames: true,
            persistAcrossSessions: true
        }]);
    }

    // queued so two events can't register the same id at once
    function ensureRemoveScript() {
        removeScriptSync = removeScriptSync.then(syncRemoveScript).catch(console.error);
        return removeScriptSync;
    }

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local") return;
        if (changes.proxyConfig) applyProxy().catch(console.error);
        if (changes.versionSelection) ensureRemoveScript();
    });

    ensureRemoveScript();

    // leftover rule from an old build, can be deleted later
    chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [9998] }).catch(console.error);

    chrome.runtime.onStartup.addListener(() => {
        registerCspBypassRule().catch(console.error);
        applyProxy().catch(console.error);
        ensureRemoveScript();
    });

    interface SettingsSchema {
        accessToken?: string;
        versionSelection?: string;
        fingerprint?: Record<string, string>;
    }

    const KNOWN_ERRORS = ["invalid_access_token", "device_limit", "missing_fingerprint", "server_error"];

    async function getLatestVersion() {
        const response = await fetch(`${baseURL}/versions.json`);
        const data = await response.json();
        return data.versions[data.latest];
    }

    async function fetchAsset(path: string, key: string, fingerprint: Record<string, string>) {
        const response = await fetch(`${baseURL}/${path}`, {
            headers: {
                authorization: `Bearer ${key}`,
                "x-hardware-fingerprint": btoa(JSON.stringify(fingerprint))
            }
        });

        if (!response.ok) {
            let reason = "server_error";

            try {
                const data = await response.json();
                if (typeof data?.error === "string") reason = data.error;
            } catch { }

            throw new Error(reason);
        }

        const isTextAsset = path.endsWith(".html") || path.endsWith(".css") || path.endsWith(".js");
        return isTextAsset ? response.text() : await response.json();
    }

    chrome.runtime.onInstalled.addListener((details) => {
        registerCspBypassRule().catch(console.error);
        applyProxy().catch(console.error);
        ensureRemoveScript();

        if (details.reason === "install") {
            chrome.tabs.create({
                url: chrome.runtime.getURL("index.html")
            });
        }
    });

    chrome.action.onClicked.addListener(() => {
        chrome.tabs.create({
            url: chrome.runtime.getURL("index.html")
        });
    });

    // moomoo.io and its subdomains, not look-alikes like notmoomoo.io
    function isMooMooPage(url: string) {
        try {
            const host = new URL(url).hostname;
            return host === "moomoo.io" || host.endsWith(".moomoo.io");
        } catch {
            return false;
        }
    }

    chrome.webNavigation.onCommitted.addListener((details) => {
        if (details.frameId !== 0) return;
        if (!isMooMooPage(details.url)) return;

        chrome.storage.local.get(["accessToken", "versionSelection", "fingerprint"], async (items: SettingsSchema) => {
            if (!items.accessToken || !items.fingerprint) {
                chrome.tabs.remove(details.tabId);
                return chrome.tabs.create({
                    url: chrome.runtime.getURL(`index.html`)
                });
            }

            // no mod mode, let the page load normally
            if (items.versionSelection === "none") return;

            const token = items.accessToken;
            const fingerprint = items.fingerprint;
            let version = "latest";

            if (items.versionSelection) {
                version = items.versionSelection;
            }

            if (version === "latest") {
                try {
                    version = await getLatestVersion();
                } catch (e) { }
            }

            try {
                const htmlContent = await fetchAsset(`${version}/index.html`, token, fingerprint);
                const cssContent = await fetchAsset(`${version}/style.css`, token, fingerprint);
                const jsContent = await fetchAsset(`${version}/bundle.js`, token, fingerprint);

                chrome.scripting.executeScript({
                    target: { tabId: details.tabId, frameIds: [details.frameId] },
                    injectImmediately: true,
                    world: "MAIN",
                    func: injectDynamicLoader,
                    args: [htmlContent, cssContent, jsContent]
                });
            } catch (e) {
                const reason = e instanceof Error && KNOWN_ERRORS.includes(e.message) ? e.message : "server_unreachable";

                chrome.tabs.remove(details.tabId);
                chrome.tabs.create({
                    url: chrome.runtime.getURL(`index.html?error=${encodeURIComponent(reason)}`)
                });
            }
        });
    });

    function injectDynamicLoader(htmlContent: string, cssContent: string, jsContent: string) {
        (window as any).oldHTML = document.documentElement.innerHTML;
        document.documentElement.innerHTML = htmlContent;

        const styleElement = document.createElement("style");
        styleElement.innerHTML = cssContent;
        document.head.appendChild(styleElement);

        const turnstile = document.createElement("script");
        turnstile.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
        document.head.appendChild(turnstile);

        turnstile.onload = async () => {
            const runtimeScript = document.createElement("script");
            runtimeScript.innerText = jsContent;
            document.head.appendChild(runtimeScript);

            if (typeof (window as any).initFalconClient === "function") {
                (window as any).initFalconClient();
                delete (window as any).initFalconClient;
                runtimeScript.remove();
                return;
            }

            let interval = setInterval(() => {
                if (typeof (window as any).initFalconClient === "function") {
                    clearInterval(interval);
                    (window as any).initFalconClient();
                    delete (window as any).initFalconClient;
                    runtimeScript.remove();
                }
            }, 500);
        };
    }
})();