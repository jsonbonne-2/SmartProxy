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
import { WebRequestMonitor, RequestMonitorEvent } from "./WebRequestMonitor";
import { Core } from "./Core";
import { PolyFill } from "../lib/PolyFill";
import { ProxyRules } from "./ProxyRules";
import { Utils } from "../lib/Utils";
import { TabManager, TabDataType } from "./TabManager";
import { CommandMessages, FailedRequestType, CompiledProxyRule, CompiledProxyRulesMatchedSource, TabConnectivityTestStatus } from "./definitions";
import { Settings } from "./Settings";
import { Debug } from "../lib/Debug";
import { ProfileRules } from "./ProfileRules";
import { SettingsOperation } from "./SettingsOperation";
import { ProxyEngine } from "./ProxyEngine";
import { api } from "../lib/environment";
import { ProfileOperations } from "./ProfileOperations";

export class WebFailedRequestMonitor {

	public static startMonitor() {
		// start the request monitor for failures
		WebRequestMonitor.startMonitor(WebFailedRequestMonitor.requestMonitorCallback);
	}

	private static notifyFailedRequestNotification: boolean = true;

	public static enableFailedRequestNotification() {
		WebFailedRequestMonitor.notifyFailedRequestNotification = true;
		Debug.log("FailedRequestNotification is Enabled");
	}

	public static disableFailedRequestNotification() {
		WebFailedRequestMonitor.notifyFailedRequestNotification = false;
		Debug.log("FailedRequestNotification is Disabled");
	}

	/** Domain is being added to the rules list, so removing it from failed requests list */
	public static removeDomainsFromTabFailedRequests(tabId: number, domainList: string[]) {
		if (!(tabId > -1))
			return null;
		if (!domainList || !domainList.length)
			return null;

		let tabData = TabManager.getTab(tabId);

		if (!tabData)
			return null;

		let failedRequests = tabData.failedRequests;
		if (!failedRequests) return null;

		for (let domain of domainList) {
			WebFailedRequestMonitor.deleteFailedRequests(failedRequests, domain);
		}

		let settingsActive = Settings.active;
		let activeSmartProfile = settingsActive.activeProfile;

		// rechecking the failed requests
		failedRequests.forEach((request, key, map) => {
			let testResult = ProxyRules.findMatchedDomainInRulesInfo(request.domain, activeSmartProfile.compiledRules);

			if (testResult != null) {
				WebFailedRequestMonitor.deleteFailedRequests(failedRequests, request.domain);
			}
		});

		return failedRequests;
	}

	/** Monitor entry point */
	private static requestMonitorCallback(eventType: RequestMonitorEvent, requestDetails: any) {
		if (!Settings.current.options.detectRequestFailures)
			return;

		let tabId = requestDetails.tabId;
		if (tabId < 0)
			return null;

		let tabData = TabManager.getOrSetTab(tabId, false);

		if (!tabData)
			return;

		let requestUrl = requestDetails.url;
		if (WebFailedRequestMonitor.checkIfUrlIgnored(requestUrl)) {
			// no logging or reporting requested to ignore domains
			return;
		}

		let requestHost = Utils.extractHostFromUrl(requestUrl);
		let failedRequests = tabData.failedRequests || (tabData.failedRequests = new Map<string, FailedRequestType>());

		// Uncomment for verbose events: DiagDebug?.trace("WebFailedMonitorCall", 't=' + tabId, RequestMonitorEvent[eventType], requestHost);

		switch (eventType) {
			case RequestMonitorEvent.RequestStart:
				{
					// Handle new domain connectivity test start
					WebFailedRequestMonitor.handleNewDomainConnectivityStart(requestDetails, tabData);
					break;
				}
			case RequestMonitorEvent.RequestComplete:
				{
					// Handle new domain connectivity test result
					WebFailedRequestMonitor.handleNewDomainConnectivityComplete(requestDetails, tabData);

					// Auto-whitelist successful main frame requests
					WebFailedRequestMonitor.autoWhitelistSuccessfulMainFrame(requestDetails, tabData);

					// remove the log
					let removed = WebFailedRequestMonitor.deleteFailedRequests(failedRequests, requestHost);

					if (removed) {
						// if there was an entry

						// send message to the tab
						WebFailedRequestMonitor.sendWebFailedRequestNotification(
							tabId,
							null,
							failedRequests);

						Core.setBrowserActionStatus(tabData);
					}
					break;
				}

			case RequestMonitorEvent.RequestRevertTimeout:
				{
					// remove the log
					let removed = WebFailedRequestMonitor.deleteFailedRequests(failedRequests, requestHost);

					if (removed) {
						// if there was an entry

						// send message to the tab
						WebFailedRequestMonitor.sendWebFailedRequestNotification(
							tabId,
							null,
							failedRequests);

						Core.setBrowserActionStatus(tabData);
					}
					break;
				}

			case RequestMonitorEvent.RequestRedirected:
				{
					let failedInfo = failedRequests.get(requestHost);
					if (!failedInfo) {

						// considering redirect as complete
						WebFailedRequestMonitor.deleteFailedRequests(failedRequests, requestHost);

						// send message to the tab
						WebFailedRequestMonitor.sendWebFailedRequestNotification(
							tabId,
							failedInfo,
							failedRequests);

						Core.setBrowserActionStatus(tabData);
					}

					break;
				}

			case RequestMonitorEvent.RequestTimeoutAborted:
				{
					// request is either aborted or timeout, doesn't matter
					// it should not be considered as failed.

					let failedInfo = failedRequests.get(requestHost);
					if (!failedInfo) {

						// send message to the tab
						WebFailedRequestMonitor.sendWebFailedRequestNotification(
							tabId,
							failedInfo,
							failedRequests);

						Core.setBrowserActionStatus(tabData);
					}

					break;
				}

			case RequestMonitorEvent.RequestTimeout:
			case RequestMonitorEvent.RequestError:
				{
					// Handle new domain connectivity test failure
					if (requestDetails.type === 'main_frame') {
						let handled = WebFailedRequestMonitor.handleNewDomainConnectivityFailure(requestDetails, tabData);
						if (handled) {
							// New domain test was handled - we added rules and will refresh
							// Don't continue with normal failure handling
							break;
						}
					}

					let failedInfo = failedRequests.get(requestHost);
					if (failedInfo) {
						if (eventType == RequestMonitorEvent.RequestError) {
							// only on error increase hit count
							failedInfo.hitCount += 1;
						}
					} else {

						let settingsActive = Settings.active;
						let activeSmartProfile = settingsActive.activeProfile;

						let shouldNotifyFailures = false;
						let proxyableDomainList = Utils.extractSubdomainListFromHost(requestHost);

						if (proxyableDomainList && proxyableDomainList.length > 1) {

							let multiTestResultList = ProxyRules.findMatchedDomainListInRulesInfo(proxyableDomainList, activeSmartProfile.compiledRules);
							let requestHostRule: CompiledProxyRule = null;
							let anyDomainHasWhitelistRule = false;

							// checking if the request itself has rule or not
							for (let result of multiTestResultList) {
								if (!result) continue;

								// Check if any domain has a whitelist rule (skip failed request tracking)
								if (result.matchedRuleSource == CompiledProxyRulesMatchedSource.WhitelistRules ||
									result.matchedRuleSource == CompiledProxyRulesMatchedSource.WhitelistSubscriptionRules) {
									anyDomainHasWhitelistRule = true;
								}

								if (result.compiledRule.hostName == requestHost) {
									requestHostRule = result.compiledRule;
								}
							}

							// Skip failed request tracking if any domain has a whitelist rule
							if (anyDomainHasWhitelistRule) {
								break;
							}

							// add only if the request doesn't have rule
							if (requestHostRule == null) {

								// adding the sub-domains and top-level domain all together
								for (let i = 0; i < multiTestResultList.length; i++) {
									let resultRuleInfo = multiTestResultList[i];
									let resultRule = resultRuleInfo?.compiledRule;
									let domain = proxyableDomainList[i];
									let matchedHost = resultRule?.hostName || domain;

									failedInfo = new FailedRequestType();
									failedInfo.url = requestDetails.url;
									failedInfo.domain = domain;
									failedInfo.hitCount = 1;

									let ruleIsForThisHost = false;
									if (resultRule != null) {
										// check to see if the matched rule is for this host or not!
										if (resultRule.hostName == domain) {
											ruleIsForThisHost = true;
										}

										failedInfo.hasRule = true;
										failedInfo.ruleId = resultRule.ruleId;
										failedInfo.isRuleForThisHost = ruleIsForThisHost;
									}
									else {
										failedInfo.hasRule = false;
										failedInfo.ruleId = null;
										failedInfo.isRuleForThisHost = false;

										shouldNotifyFailures = true;
									}
									failedInfo.isRootHost = requestHost == matchedHost;

									WebFailedRequestMonitor.markIgnoreDomain(failedInfo, domain);
									// add to the list
									failedRequests.set(domain, failedInfo);

									// Auto-add to proxy if tab is proxified
									WebFailedRequestMonitor.autoAddFailedRequestIfProxified(tabData, domain, failedInfo);
								}
							} else {
								// the root has match, just add it to prevent further checks
								failedInfo = new FailedRequestType();
								failedInfo.url = requestDetails.url;
								failedInfo.domain = requestHost;
								failedInfo.hitCount = 1;
								failedInfo.hasRule = true;
								failedInfo.ruleId = requestHostRule.ruleId;

								WebFailedRequestMonitor.markIgnoreDomain(failedInfo, requestHost);

								// add to the list
								failedRequests.set(requestHost, failedInfo);
							}

							if (shouldNotifyFailures) {
								// send message to the tab
								// only on the first hit
								WebFailedRequestMonitor.sendWebFailedRequestNotification(
									tabId,
									failedInfo,
									failedRequests);

								Core.setBrowserActionStatus(tabData);
							}

						} else if (proxyableDomainList && proxyableDomainList.length == 1) {
							failedInfo = new FailedRequestType();
							failedInfo.url = requestDetails.url;
							failedInfo.domain = requestHost;
							failedInfo.hitCount = 1;
							failedInfo.hasRule = false;

							let testResult = ProxyRules.findMatchedUrlInRulesInfo(requestUrl, activeSmartProfile.compiledRules);

							if (testResult != null) {
								// there is a rule for this url, so don't bother
								// we are just adding this to prevent
								// further call to 'proxyRules.testSingleRule' which is expensive
								failedInfo.hasRule = true;
								failedInfo.ruleId = testResult.compiledRule.ruleId;
							}

							WebFailedRequestMonitor.markIgnoreDomain(failedInfo, requestHost);

							// add to the list
							failedRequests.set(requestHost, failedInfo);

							// Auto-add to proxy if tab is proxified
							WebFailedRequestMonitor.autoAddFailedRequestIfProxified(tabData, requestHost, failedInfo);

							// send only if there is no rule
							if (!failedInfo.hasRule && !failedInfo.ignored) {
								// send message to the tab
								// only on the first hit
								WebFailedRequestMonitor.sendWebFailedRequestNotification(
									tabId,
									failedInfo,
									failedRequests);

								Core.setBrowserActionStatus(tabData);
							}
						}
					}
				}
		}
	}

	/** Auto-whitelist successful main frame requests */
	private static autoWhitelistSuccessfulMainFrame(requestDetails: any, tabData: TabDataType) {
		// Check if option is enabled
		if (!Settings.current.options.autoWhitelistSuccessfulDomains) {
			return;
		}

		// Only process main frame requests
		if (requestDetails.type !== 'main_frame') {
			return;
		}

		let requestUrl = requestDetails.url;
		let requestHost = Utils.extractHostFromUrl(requestUrl);

		// Skip internal/local hosts
		if (!Utils.isNotInternalHostName(requestHost)) {
			return;
		}

		// Check if there's already a matching proxy rule for this host
		let settingsActive = Settings.active;
		let activeSmartProfile = settingsActive.activeProfile;
		let testResult = ProxyRules.findMatchedDomainInRulesInfo(requestHost, activeSmartProfile.compiledRules);

		if (testResult != null) {
			// Already has a rule (proxy or whitelist), no need to whitelist
			return;
		}

		// No rule exists and main frame loaded successfully - add to whitelist
		Debug.log(`Auto-whitelisting successful domain: ${requestHost}`);

		let result = ProfileRules.whitelistByHostname(requestHost, tabData.tabId);
		if (result?.success) {
			// Save settings
			SettingsOperation.saveSmartProfiles();
			SettingsOperation.saveAllSync();

			// Notify proxy engine
			ProxyEngine.notifyProxyRulesChanged();

			Debug.log(`Auto-whitelisted ${result.autoAddedCount + 1} domains for ${requestHost}`);
		}
	}

	/** Marks the a failed request to be ignored if it is requested by user using the ignore rules. */
	private static markIgnoreDomain(failedInfo: FailedRequestType, requestHost: string) {

		if (WebFailedRequestMonitor.checkIfDomainIgnored(requestHost)) {
			Debug.info("markIgnoreDomain=true", requestHost, failedInfo);
			failedInfo.ignored = true;
		}
	}

	/** Auto-add failed request domain to the same proxy as tab's main domain */
	private static autoAddFailedRequestIfProxified(tabData: TabDataType, requestHost: string, failedInfo: FailedRequestType) {
		// Check if main domain has a proxy rule (even if tab.proxified is not yet set)
		let settingsActive = Settings.active;
		let activeSmartProfile = settingsActive.activeProfile;
		let mainDomainRule = null;

		Debug.log(`[AutoProxy] host=${requestHost}, proxyRuleHostName=${tabData.proxyRuleHostName}, tabUrl=${tabData.url}`);

		// If tab has a proxy rule hostname, check if it has a rule
		if (tabData.proxyRuleHostName) {
			mainDomainRule = ProxyRules.findMatchedDomainInRulesInfo(tabData.proxyRuleHostName, activeSmartProfile.compiledRules);
		} else if (tabData.url) {
			// Try to get main domain from tab URL
			let mainHost = Utils.extractHostFromUrl(tabData.url);
			if (mainHost) {
				mainDomainRule = ProxyRules.findMatchedDomainInRulesInfo(mainHost, activeSmartProfile.compiledRules);
				Debug.log(`[AutoProxy] mainHost=${mainHost}, mainDomainRule=${mainDomainRule?.matchedRuleSource}`);
				// Cache the proxy rule hostname for future use
				if (mainDomainRule && mainDomainRule.matchedRuleSource !== CompiledProxyRulesMatchedSource.WhitelistRules &&
					mainDomainRule.matchedRuleSource !== CompiledProxyRulesMatchedSource.WhitelistSubscriptionRules) {
					tabData.proxyRuleHostName = mainHost;
				}
			}
		}

		// Only auto-add if main domain has a proxy rule (not whitelist)
		if (!mainDomainRule || mainDomainRule.matchedRuleSource === CompiledProxyRulesMatchedSource.WhitelistRules ||
			mainDomainRule.matchedRuleSource === CompiledProxyRulesMatchedSource.WhitelistSubscriptionRules) {
			Debug.log(`[AutoProxy] Skipping ${requestHost} - main domain has no proxy rule`);
			return;
		}

		// Skip if already has a precise rule for this host or is ignored
		// Note: hasRule may be true even if the rule is for a parent domain (wildcard/subdomain matching)
		// We only skip if the rule is specifically for this host (isRuleForThisHost=true)
		Debug.log(`[AutoProxy] hasRule=${failedInfo.hasRule}, isRuleForThisHost=${failedInfo.isRuleForThisHost}, ignored=${failedInfo.ignored}`);
		if ((failedInfo.hasRule && failedInfo.isRuleForThisHost === true) || failedInfo.ignored) {
			Debug.log(`[AutoProxy] Skipping ${requestHost} - has precise rule or ignored`);
			return;
		}

		// Skip internal/local domains
		if (!Utils.isNotInternalHostName(requestHost)) {
			return;
		}

		// Skip if same as main hostname
		if (tabData.proxyRuleHostName && requestHost === tabData.proxyRuleHostName) {
			return;
		}

		// Add the rule
		let result = ProfileRules.enableByHostname(requestHost);
		if (result?.success && result.rule) {
			// Mark as having a rule now
			failedInfo.hasRule = true;
			failedInfo.ruleId = result.rule.ruleId;

			// If the main domain's rule has a specific proxy, apply it to this rule too
			if (mainDomainRule.compiledRule?.proxyServerId) {
				ProfileRules.changeProxyForRule(result.rule.ruleId, mainDomainRule.compiledRule.proxyServerId);
			}

			// Save settings
			SettingsOperation.saveSmartProfiles();
			SettingsOperation.saveAllSync();

			// Notify proxy engine
			ProxyEngine.notifyProxyRulesChanged();
		}
	}

	private static checkIfUrlIgnored(requestUrl: string): boolean {

		let ignoreFailureProfile = Settings.active.currentIgnoreFailureProfile;
		if (!ignoreFailureProfile)
			return false;

		let matchedRule = ProxyRules.findMatchedUrlInRules(requestUrl, ignoreFailureProfile.compiledRules.Rules);
		if (matchedRule) {
			return true;
		}

		return false;
	}

	/** Checks if a domain is in ignore rules list */
	private static checkIfDomainIgnored(requestHost: string): boolean {

		let ignoreFailureProfile = Settings.active.currentIgnoreFailureProfile;
		if (!ignoreFailureProfile)
			return false;

		let matchedRule = ProxyRules.findMatchedDomainRule(requestHost, ignoreFailureProfile.compiledRules.Rules);
		if (matchedRule) {
			return true;
		}

		return false;
	}

	private static sendWebFailedRequestNotification(tabId: number, failedInfo: FailedRequestType, failedRequests: Map<string, FailedRequestType>) {
		if (!WebFailedRequestMonitor.notifyFailedRequestNotification)
			return;

		PolyFill.runtimeSendMessage(
			{
				command: CommandMessages.WebFailedRequestNotification,
				tabId: tabId,
				failedRequests: WebFailedRequestMonitor.convertFailedRequestsToArray(failedRequests),
				//failedInfo: failedInfo TODO: not used? remove then.
			},
			null,
			error => {
				if (error && error["message"] &&
					error.message.includes("Could not establish connection")) {
					WebFailedRequestMonitor.disableFailedRequestNotification();
				}
			});
	}

	/** Converts failed requests to array */
	public static convertFailedRequestsToArray(failedRequests: Map<string, FailedRequestType>): FailedRequestType[] {

		let result: FailedRequestType[] = [];

		failedRequests.forEach((value, key, map) => {
			result.push(value);
		});

		return result;
	}

	/** Number of un-proxified requests */
	public static failedRequestsNotProxifiedCount(failedRequests: Map<string, FailedRequestType>): number {
		let failedCount = 0;

		failedRequests.forEach((request, key, map) => {
			if (request.hasRule || request.ignored)
				return;

			if (request.isRootHost)
				failedCount += request.hitCount;
		});

		return failedCount;
	}

	/** Remove the domain from failed list. Also removed the parent if parent doesn't any other subdomain. */
	private static deleteFailedRequests(failedRequests: Map<string, FailedRequestType>, requestHost: string): boolean {

		if (requestHost == null)
			return false;

		let isRemoved = failedRequests.delete(requestHost);

		let subDomains = Utils.extractSubdomainListFromHost(requestHost);
		if (subDomains && subDomains.length) {
			subDomains.reverse();

			subDomains.forEach((subDomain, index) => {

				let domainHasSubDomain = false;
				failedRequests.forEach((request, requestDomainKey, map) => {
					if (domainHasSubDomain)
						return;
					if (requestDomainKey.endsWith("." + subDomain)) {
						domainHasSubDomain = true;
					}
				});

				if (domainHasSubDomain)
					return;

				let removed = failedRequests.delete(subDomain);
				isRemoved = removed || isRemoved;
			});
		}
		return isRemoved;
	}

	/** Handle successful main frame request for new domain connectivity test */
	private static handleNewDomainConnectivityComplete(requestDetails: any, tabData: TabDataType) {
		// Check if option is enabled
		if (!Settings.current.options.testNewDomainConnectivity) {
			return;
		}

		// Only process main frame requests
		if (requestDetails.type !== 'main_frame') {
			return;
		}

		// Check if this tab is in testing mode
		if (tabData.connectivityTestStatus !== TabConnectivityTestStatus.Testing) {
			return;
		}

		let requestHost = Utils.extractHostFromUrl(requestDetails.url);

		// Skip internal/local hosts
		if (!Utils.isNotInternalHostName(requestHost)) {
			return;
		}

		Debug.log(`[NewDomainTest] Main frame SUCCESS: ${requestHost} - adding to whitelist`);

		// Mark as direct success
		tabData.connectivityTestStatus = TabConnectivityTestStatus.DirectSuccess;

		// Get all loaded URLs for this tab
		let loadedUrls = tabData.getLoadedUrls();
		let domainsToAdd = new Set<string>();

		// Extract all unique domains from loaded URLs
		for (let url of loadedUrls) {
			try {
				let urlObj = new URL(url);
				let host = urlObj.hostname;
				if (Utils.isNotInternalHostName(host)) {
					domainsToAdd.add(host);
				}
			} catch (e) {
				// Invalid URL, skip
			}
		}

		// Also add the main frame domain
		domainsToAdd.add(requestHost);

		// Add all domains to whitelist
		let addedCount = 0;
		for (let domain of domainsToAdd) {
			let result = ProfileRules.whitelistByHostname(domain, tabData.tabId);
			if (result?.success) {
				addedCount++;
			}
		}

		if (addedCount > 0) {
			Debug.log(`[NewDomainTest] Added ${addedCount} domains to whitelist for ${requestHost}`);

			// Save settings
			SettingsOperation.saveSmartProfiles();
			SettingsOperation.saveAllSync();

			// Notify proxy engine
			ProxyEngine.notifyProxyRulesChanged();
		}
	}

	/** Handle failed main frame request for new domain connectivity test */
	private static handleNewDomainConnectivityFailure(requestDetails: any, tabData: TabDataType): boolean {
		// Check if option is enabled
		if (!Settings.current.options.testNewDomainConnectivity) {
			return false;
		}

		let requestHost = Utils.extractHostFromUrl(requestDetails.url);

		// Skip internal/local hosts
		if (!Utils.isNotInternalHostName(requestHost)) {
			return false;
		}

		// Check if active profile supports adding rules
		let settingsActive = Settings.active;
		let activeSmartProfile = settingsActive.activeProfile;

		if (!activeSmartProfile ||
			!ProfileOperations.profileTypeSupportsRules(activeSmartProfile.profileType) ||
			!activeSmartProfile.profileTypeConfig?.editable) {
			return false;
		}

		// Check if there's already a matching rule for this host
		let testResult = ProxyRules.findMatchedDomainInRulesInfo(requestHost, activeSmartProfile.compiledRules);
		if (testResult != null) {
			return false;
		}

		// CRITICAL: Check if there's a valid proxy server configured
		let currentProxyServer = settingsActive.currentProxyServer;
		if (!currentProxyServer || !currentProxyServer.host || !currentProxyServer.port) {
			return false;
		}

		// Mark as proxy needed
		tabData.connectivityTestStatus = TabConnectivityTestStatus.ProxyNeeded;

		// Get all loaded URLs for this tab
		let loadedUrls = tabData.getLoadedUrls();
		let domainsToAdd = new Set<string>();

		// Extract all unique domains from loaded URLs
		for (let url of loadedUrls) {
			try {
				let urlObj = new URL(url);
				let host = urlObj.hostname;
				if (Utils.isNotInternalHostName(host)) {
					domainsToAdd.add(host);
				}
			} catch (e) {
				// Invalid URL, skip
			}
		}

		// Also add the main frame domain
		domainsToAdd.add(requestHost);

		// Add all domains to proxy rules
		let addedCount = 0;
		for (let domain of domainsToAdd) {
			let result = ProfileRules.enableByHostname(domain);
			if (result?.success) {
				addedCount++;
			}
		}

		if (addedCount > 0) {
			// Set the proxy rule hostname for the tab so sub-resources can be auto-proxied
			tabData.proxyRuleHostName = requestHost;

			// Save settings
			SettingsOperation.saveSmartProfiles();
			SettingsOperation.saveAllSync();

			// Notify proxy engine to update PAC script
			ProxyEngine.notifyProxyRulesChanged();

			// Delay refresh to allow PAC script to update
			// Use tabs.update with the original URL instead of reload
			// because reload would refresh the error page, not the original URL
			const tabId = tabData.tabId;
			const originalUrl = requestDetails.url;

			setTimeout(() => {
				api.tabs.update(tabId, { url: originalUrl });
			}, 500);

			return true;
		}
		return false;
	}

	/** Handle main frame request start for new domain connectivity test */
	private static handleNewDomainConnectivityStart(requestDetails: any, tabData: TabDataType) {
		// Only process main frame requests
		if (requestDetails.type !== 'main_frame') {
			return;
		}

		let requestUrl = requestDetails.url;
		let requestHost = Utils.extractHostFromUrl(requestUrl);

		// Skip internal/local hosts
		if (!Utils.isNotInternalHostName(requestHost)) {
			return;
		}

		// Check if there's already a matching rule for this host
		let settingsActive = Settings.active;
		let activeSmartProfile = settingsActive.activeProfile;

		let testResult = ProxyRules.findMatchedDomainInRulesInfo(requestHost, activeSmartProfile.compiledRules);

		Debug.log(`[MainFrame] host=${requestHost}, hasRule=${testResult != null}, source=${testResult?.matchedRuleSource}`);

		if (testResult != null) {
			// Already has a rule - check if it's a proxy rule (not whitelist)
			if (testResult.matchedRuleSource !== CompiledProxyRulesMatchedSource.WhitelistRules &&
				testResult.matchedRuleSource !== CompiledProxyRulesMatchedSource.WhitelistSubscriptionRules) {
				// Set proxy rule hostname for sub-resources auto-proxy
				tabData.proxyRuleHostName = testResult.compiledRule.hostName || requestHost;
				Debug.log(`[MainFrame] Set proxyRuleHostName=${tabData.proxyRuleHostName}`);
			}
			// No need to test connectivity
			tabData.connectivityTestStatus = TabConnectivityTestStatus.None;
			return;
		}

		// Check if option is enabled for new domain connectivity test
		const options = Settings.current.options;
		if (!options?.testNewDomainConnectivity) {
			return;
		}

		// New domain - mark as testing
		tabData.connectivityTestStatus = TabConnectivityTestStatus.Testing;
		tabData.mainFrameDomain = requestHost;
		tabData.clearLoadedUrls();
		tabData.addLoadedUrl(requestUrl);
	}

}