/*
 * This file is part of SmartProxy <https://github.com/salarcode/SmartProxy>,
 * Copyright (C) 2022 Salar Khalilzadeh <salar2k@gmail.com>
 *
 * SmartProxy is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3 as
 * published by the Free Software Foundation.
 *
 * SmartProxy is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with SmartProxy.  If not, see <http://www.gnu.org/licenses/>.
 */
import { TabManager, TabDataType } from "./TabManager";
import { Utils } from "../lib/Utils";
import { PolyFill } from "../lib/PolyFill";
import { Debug } from "../lib/Debug";
import { ProxyRules } from "./ProxyRules";
import { CommandMessages, ProxyableLogDataType, CompiledProxyRulesMatchedSource, SmartProfileType, monitorUrlsSchemaFilter, ProxyableProxifiedStatus, ProxyableMatchedRuleStatus, CompiledProxyRuleSource, TabProxyStatus } from "./definitions";
import { api, environment } from "../lib/environment";
import { Settings } from "./Settings";
import { ProfileRules } from "./ProfileRules";
import { ProfileOperations } from "./ProfileOperations";
import { SettingsOperation } from "./SettingsOperation";
import { ProxyEngine } from "./ProxyEngine";

export class TabRequestLogger {

	private static subscribedTabList: number[] = [];
	/** Pending domains to add - used for debouncing */
	private static pendingAutoAddDomains: Set<string> = new Set();
	/** Debounce timer for auto-add saves */
	private static autoAddSaveTimer: ReturnType<typeof setTimeout> = null;
	/** Cache of domains that don't need auto-add processing (already have rules or are ignored) */
	private static skippedDomainsCache: Set<string> = new Set();
	/** Maximum cache size to prevent memory bloat */
	private static readonly MAX_CACHE_SIZE = 1000;
	/** Domains that should be skipped (internal/local/intranet) */
	private static readonly SKIP_DOMAIN_PREFIXES = ['localhost', '127.', '192.168.', '10.', '172.16.', '::1', '0.0.0.0', 'chrome:', 'about:', 'extension:', 'moz-extension:'];

	public static startTracking() {
		// unsubscribing when tab got removed
		TabManager.TabRemoved.on(TabRequestLogger.handleTabRemovedInternal);

		// Always track all loaded URLs for auto-add feature
		api.webRequest.onBeforeRequest.addListener(
			TabRequestLogger.trackLoadedUrl,
			{ urls: monitorUrlsSchemaFilter }
		);

		if (environment.chrome) {
			// this is a Chrome specific way of logging

			api.webRequest.onBeforeRequest.addListener(
				TabRequestLogger.onBeforeRequestLogRequestInternal,
				{ urls: monitorUrlsSchemaFilter }
			);
		}
	}

	/** Track all URLs loaded in tabs for auto-add feature */
	private static trackLoadedUrl(requestDetails: any) {
		let tabId = requestDetails.tabId;
		if (!(tabId > -1))
			// only requests from tabs are logged
			return;

		// Only track if auto-add options are enabled
		let options = Settings.current?.options;
		if (!options?.autoAddThirdPartyDomains && !options?.autoAddFullUrlPaths)
			return;

		// Early check: get tab data and skip if tab is not proxified
		let tabData = TabManager.getTab(tabId);
		if (!tabData || tabData.proxified !== TabProxyStatus.Proxified || !tabData.proxyRuleHostName)
			return;

		let url = requestDetails.url;
		if (!url || url.length > 2000)
			// Skip very long URLs to avoid memory issues
			return;

		// Quick validation - must be http or https
		if (!url.startsWith('http://') && !url.startsWith('https://'))
			return;

		// Early skip for internal/local domains - fast path optimization
		for (const prefix of TabRequestLogger.SKIP_DOMAIN_PREFIXES) {
			if (url.includes(prefix)) {
				return;
			}
		}

		tabData.addLoadedUrl(url);

		// Auto-add URL since tab's main domain is already proxied
		TabRequestLogger.autoAddUrlIfNeeded(url, tabData.proxyRuleHostName, tabId);
	}

	/** Auto-add URL to rules if it matches the auto-add criteria */
	private static autoAddUrlIfNeeded(url: string, mainDomain: string, tabId: number) {
		let options = Settings.current?.options;
		if (!options)
			return;

		try {
			let urlObj = new URL(url);
			let urlHost = urlObj.hostname;

			// Skip if same as main hostname
			if (urlHost === mainDomain)
				return;

			// Check cache first - skip if already processed and doesn't need auto-add
			if (TabRequestLogger.skippedDomainsCache.has(urlHost)) {
				return;
			}

			let smartProfile = ProfileOperations.getActiveSmartProfile();
			if (!smartProfile)
				return;

			// Extract root domains for third-party check
			let mainRootDomain = TabRequestLogger.extractRootDomain(mainDomain);
			let urlRootDomain = TabRequestLogger.extractRootDomain(urlHost);

			let shouldAdd = false;
			let domainToAdd: string = null;

			// Option A: Auto-add third-party domains
			if (options.autoAddThirdPartyDomains) {
				// Only add if it's a third-party domain (different root domain)
				if (urlRootDomain && mainRootDomain && urlRootDomain !== mainRootDomain) {
					if (Utils.isNotInternalHostName(urlHost)) {
						domainToAdd = urlHost;
						shouldAdd = true;
					}
				}
			}

			// Option B: Auto-add full URL paths
			if (options.autoAddFullUrlPaths && !shouldAdd) {
				// Add the full path as a rule pattern
				let fullPath = urlHost + urlObj.pathname;
				if (Utils.isNotInternalHostName(urlHost)) {
					domainToAdd = fullPath;
					shouldAdd = true;
				}
			}

			if (shouldAdd && domainToAdd) {
				// Check if rule already exists or is pending
				let existingRule = smartProfile.proxyRules.find(rule => rule.hostName === domainToAdd);
				let isPending = TabRequestLogger.pendingAutoAddDomains.has(domainToAdd);

				if (!existingRule && !isPending) {
					// Add to pending set
					TabRequestLogger.pendingAutoAddDomains.add(domainToAdd);

					// Add the rule
					ProfileRules.enableByHostname(domainToAdd);
					Debug.log(`Auto-added rule for: ${domainToAdd}`);

					// Debounce the save
					TabRequestLogger.scheduleAutoAddSave();
				} else if (existingRule) {
					// Domain already has a rule, add to skip cache
					TabRequestLogger.addToSkipCache(urlHost);
				}
			} else {
				// Domain doesn't need auto-add, cache it for future skips
				TabRequestLogger.addToSkipCache(urlHost);
			}
		} catch (e) {
			// Invalid URL, skip
		}
	}

	/** Add domain to skip cache with size limit */
	private static addToSkipCache(domain: string) {
		if (TabRequestLogger.skippedDomainsCache.size >= TabRequestLogger.MAX_CACHE_SIZE) {
			// Clear half the cache when full (simple LRU approximation)
			const entries = Array.from(TabRequestLogger.skippedDomainsCache);
			for (let i = 0; i < entries.length / 2; i++) {
				TabRequestLogger.skippedDomainsCache.delete(entries[i]);
			}
		}
		TabRequestLogger.skippedDomainsCache.add(domain);
	}

	/** Schedule a debounced save for auto-added rules */
	private static scheduleAutoAddSave() {
		// Clear existing timer
		if (TabRequestLogger.autoAddSaveTimer) {
			clearTimeout(TabRequestLogger.autoAddSaveTimer);
		}

		// Schedule save after 500ms of inactivity
		TabRequestLogger.autoAddSaveTimer = setTimeout(() => {
			TabRequestLogger.flushAutoAddRules();
		}, 500);
	}

	/** Save all auto-added rules and notify proxy */
	private static flushAutoAddRules() {
		if (TabRequestLogger.pendingAutoAddDomains.size === 0)
			return;

		Debug.log(`Saving ${TabRequestLogger.pendingAutoAddDomains.size} auto-added rules`);

		// Clear pending set
		TabRequestLogger.pendingAutoAddDomains.clear();
		TabRequestLogger.autoAddSaveTimer = null;

		// Save settings
		SettingsOperation.saveSmartProfiles();
		SettingsOperation.saveAllSync();

		// Notify proxy engine
		ProxyEngine.notifyProxyRulesChanged();
	}

	/** Extract root domain from hostname */
	private static extractRootDomain(hostname: string): string | null {
		if (!hostname) return null;

		// Remove port if present
		let host = hostname.split(':')[0];

		// Split by dots
		let parts = host.split('.');

		// Handle IP addresses
		if (parts.length === 4 && /^\d+$/.test(parts[3])) {
			return host; // It's an IP address
		}

		// For simple domains like 'example.com' or 'example.co.uk'
		if (parts.length <= 2) {
			return host;
		}

		// Common TLDs that have second-level domains
		const twoPartTlds = ['co.uk', 'com.au', 'co.nz', 'co.jp', 'com.cn', 'co.in', 'gov.uk', 'ac.uk', 'edu.au'];
		let lastTwoParts = parts.slice(-2).join('.');

		if (twoPartTlds.includes(lastTwoParts)) {
			return parts.slice(-3).join('.');
		}

		return parts.slice(-2).join('.');
	}

	public static subscribeProxyableLogs(tabId: number) {
		let index = TabRequestLogger.subscribedTabList.indexOf(tabId);

		// allowing only one instance for a tab at a time
		if (index == -1) {
			TabRequestLogger.subscribedTabList.push(tabId);
		}
	}

	public static unsubscribeProxyableLogs(tabId: number) {
		let index = TabRequestLogger.subscribedTabList.indexOf(tabId);
		if (index > -1) {
			TabRequestLogger.subscribedTabList.splice(index, 1);
		}
	}

	private static handleTabRemovedInternal(tabData: TabDataType) {
		// send notification first
		TabRequestLogger.notifyProxyableOriginTabRemoved(tabData.tabId);

		// then remove the tab from the notification list
		TabRequestLogger.unsubscribeProxyableLogs(tabData.tabId);
	}

	/** After handleProxyRequest -> this is a Firefox specific way of logging */
	public static async notifyProxyableLog(proxyLogData: ProxyableLogDataType) {
		// Note: the async/await is ignored to prevent a blocking call.

		if (TabRequestLogger.subscribedTabList.length == 0)
			return;

		// checking if this tab requested
		if (TabRequestLogger.subscribedTabList.indexOf(proxyLogData.tabId) == -1) {
			return;
		}

		TabRequestLogger.sendProxyableRequestLog(proxyLogData);
	}

	private static async sendProxyableRequestLog(logData: ProxyableLogDataType) {
		PolyFill.runtimeSendMessage(
			{
				command: CommandMessages.ProxyableRequestLog,
				tabId: logData.tabId,
				logInfo: logData
			},
			null,
			(error: Error) => {
				// no more logging for this tab
				TabRequestLogger.unsubscribeProxyableLogs(logData.tabId);

				Debug.error("sendProxyableRequestLog failed for ", logData.tabId, error);
			});
	}

	/** api.webRequest.onBeforeRequest -> this is a Chrome specific way of logging */
	private static onBeforeRequestLogRequestInternal(requestDetails: any) {
		let tabId = requestDetails.tabId;
		if (!(tabId > -1))
			// only requests from tabs are logged
			return;

		if (TabRequestLogger.subscribedTabList.length == 0)
			return;

		// checking if this tab requested
		if (TabRequestLogger.subscribedTabList.indexOf(tabId) == -1) {
			return;
		}

		if (Utils.isValidUrl(requestDetails.url)) {
			TabRequestLogger.notifyProxyableLogRequestInternal(requestDetails.url, tabId);
		}
	}

	/** api.webRequest.onBeforeRequest -> this is a Chrome specific way of logging */
	private static async notifyProxyableLogRequestInternal(url: string, tabId: number) {
		let proxyableData = TabRequestLogger.getProxyableDataForUrl(url);
		proxyableData.tabId = tabId;

		TabRequestLogger.sendProxyableRequestLog(proxyableData);
	}

	private static notifyProxyableOriginTabRemoved(tabId: number) {

		let index = TabRequestLogger.subscribedTabList.indexOf(tabId);
		if (index == -1) {
			return;
		}

		PolyFill.runtimeSendMessage(
			{
				command: CommandMessages.ProxyableOriginTabRemoved,
				tabId: tabId
			},
			null,
			(error: Error) => {
				Debug.error("notifyProxyableOriginTabRemoved failed for ", tabId, error);
			});
	}

	//** get proxyable log info -> this is a Chrome specific way of logging */
	private static getProxyableDataForUrl(url: string): ProxyableLogDataType {

		// TODO: This method needs to be removed/replaced with a better implementation that shares the logic between Firefox and Chrome

		let settingsActive = Settings.active;

		let activeSmartProfile = settingsActive.activeProfile;
		if (!activeSmartProfile) {

			let result = new ProxyableLogDataType();
			result.url = url;
			result.ruleHostName = "";
			result.rulePatternText = "";
			result.proxifiedStatus = ProxyableProxifiedStatus.NoProxy;
			result.matchedRuleStatus = ProxyableMatchedRuleStatus.NoneMatched;

			return result;
		}

		let testResultInfo = ProxyRules.findMatchedUrlInRulesInfo(url, activeSmartProfile.compiledRules);
		let testResultRule = testResultInfo?.compiledRule;

		let result = new ProxyableLogDataType();
		result.url = url;
		result.ruleHostName = "";
		result.rulePatternText = "";
		result.proxifiedStatus = ProxyableProxifiedStatus.NoProxy;
		result.matchedRuleStatus = ProxyableMatchedRuleStatus.NoneMatched;

		if (testResultRule != null) {
			result.applyFromRule(testResultRule);
			result.ruleHostName = testResultRule.hostName;
			result.proxifiedStatus = ProxyableProxifiedStatus.MatchedRule;
			result.matchedRuleStatus = ProxyableMatchedRuleStatus.MatchedRule;
			result.ruleSource = CompiledProxyRuleSource.Rules;

			if (testResultRule.whiteList) {
				result.matchedRuleStatus = ProxyableMatchedRuleStatus.Whitelisted;
				result.proxifiedStatus = ProxyableProxifiedStatus.NoProxy;
			}
			if (activeSmartProfile.profileType == SmartProfileType.AlwaysEnabledBypassRules) {
				result.matchedRuleStatus = ProxyableMatchedRuleStatus.AlwaysEnabledByPassed;
			}

			if (testResultInfo.matchedRuleSource == CompiledProxyRulesMatchedSource.SubscriptionRules ||
				testResultInfo.matchedRuleSource == CompiledProxyRulesMatchedSource.WhitelistSubscriptionRules) {
				result.ruleSource = CompiledProxyRuleSource.Subscriptions;
			}
		}

		if (activeSmartProfile.profileType == SmartProfileType.SystemProxy) {
			result.proxifiedStatus = ProxyableProxifiedStatus.SystemProxyApplied;
		}

		return result;
	}
}
