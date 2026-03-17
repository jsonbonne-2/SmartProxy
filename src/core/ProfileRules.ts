import { api } from "../lib/environment";
import { Utils } from "../lib/Utils";
import { ProxyRule, ProxyRuleType, RuleId, SmartProfile, ProxyRuleSpecialProxyServer, ProxyServer } from "./definitions";
import { ProfileOperations } from "./ProfileOperations";
import { SettingsOperation } from "./SettingsOperation";
import { Settings } from "./Settings";
import { TabManager } from "./TabManager";

export class ProfileRules {


	public static toggleRule(hostName: string, ruleId?: RuleId) {

		let smartProfile = ProfileOperations.getActiveSmartProfile();
		if (smartProfile == null)
			return;

		if (!ProfileOperations.profileTypeSupportsRules(smartProfile.profileType))
			return;

		if (ruleId > 0) {
			let rule = ProfileRules.getRuleById(smartProfile, ruleId);

			if (rule != null) {
				ProfileRules.removeRule(smartProfile, rule);
				return;
			}
		}

		if (!Utils.isNotInternalHostName(hostName))
			// this is an extra check!
			return;

		ProfileRules.toggleRuleByHostname(smartProfile, hostName);
	}

	public static removeByHostname(hostName: string, ruleId?: number): {
		success: boolean,
		message: string,
		rule: ProxyRule
	} {
		let smartProfile = ProfileOperations.getActiveSmartProfile();
		if (smartProfile == null)
			return;

		if (!smartProfile.profileTypeConfig.editable) {
			return {
				success: false,
				message: api.i18n.getMessage("settingsEnableByDomainSmartProfileNonEditable").replace("{0}", smartProfile.profileName),
				rule: null
			};
		}

		// get the rule for the source
		let rule: ProxyRule;

		if (ruleId > 0)
			rule = ProfileRules.getRuleById(smartProfile, ruleId);
		else
			rule = ProfileRules.getRuleByHostname(smartProfile, hostName);

		if (rule != null) {
			ProfileRules.removeRule(smartProfile, rule);

			return {
				success: true,
				message: null,
				rule: rule
			};
		}
		return {
			success: false,
			message: api.i18n.getMessage("settingsNoRuleFoundForDomain").replace("{0}", hostName),
			rule: null
		};
	}

	public static enableByHostnameListIgnoreFailureRules(hostnameList: string[]) {
		if (!hostnameList || !hostnameList.length)
			return {
				success: false,
				message: api.i18n.getMessage("settingsEnableByDomainInvalid")
			};

		let ignoreRulesProfile = ProfileOperations.getIgnoreFailureRulesProfile();
		if (ignoreRulesProfile == null)
			// TODO: this message is a temporary workaround, an UI is needed for popup in Add to Ignore List
			return {
				success: false,
				message: 'Ignore rules profile not found'
			};

		for (let hostName of hostnameList) {
			let enableResult = ProfileRules.enableByHostnameInternal(ignoreRulesProfile, hostName);
			if (enableResult && !enableResult.success) {
				return {
					success: false,
					message: enableResult.message || `Failed to add host '${hostName}' to ignore rules`
				};
			}
		}
		return {
			success: true,
			message: null
		};
	}

	public static enableByHostnameList(hostnameList: string[]): {
		success: boolean,
		message: string
	} {
		if (!hostnameList || !hostnameList.length)
			return {
				success: false,
				message: api.i18n.getMessage("settingsEnableByDomainInvalid")
			};

		let smartProfile = ProfileOperations.getActiveSmartProfile();
		if (smartProfile == null)
			// TODO: this message is a temporary workaround, an UI is needed for popup in Add to Ignore List
			return {
				success: false,
				message: 'Please select a profile first.'
			};

		if (!smartProfile.profileTypeConfig.editable ||
			!ProfileOperations.profileTypeSupportsRules(smartProfile.profileType)) {
			return {
				success: false,
				message: api.i18n.getMessage("settingsEnableByDomainSmartProfileNonEditable").replace("{0}", smartProfile.profileName),
			};
		}

		for (let hostName of hostnameList) {
			let enableResult = ProfileRules.enableByHostnameInternal(smartProfile, hostName);
			if (enableResult && !enableResult.success) {
				return {
					success: false,
					message: enableResult.message || `Failed to add host '${hostName}' to rules`
				};
			}
		}
		return {
			success: true,
			message: null
		};
	}

	public static enableByHostname(hostname: string): {
		success: boolean,
		message: string,
		rule: ProxyRule
	} {
		let smartProfile = ProfileOperations.getActiveSmartProfile();
		if (smartProfile == null)
			return;

		if (!smartProfile.profileTypeConfig.editable ||
			!ProfileOperations.profileTypeSupportsRules(smartProfile.profileType)) {
			return {
				success: false,
				message: api.i18n.getMessage("settingsEnableByDomainSmartProfileNonEditable").replace("{0}", smartProfile.profileName),
				rule: null
			};
		}

		return ProfileRules.enableByHostnameInternal(smartProfile, hostname);
	}

	public static changeProxyForRule(ruleId: number, proxyServerId: string): {
		success: boolean,
		message: string,
		rule: ProxyRule
	} {
		let smartProfile = ProfileOperations.getActiveSmartProfile();
		if (smartProfile == null) {
			return {
				success: false,
				message: "No active profile found",
				rule: null
			};
		}

		if (!smartProfile.profileTypeConfig.editable ||
			!ProfileOperations.profileTypeSupportsRules(smartProfile.profileType)) {
			return {
				success: false,
				message: api.i18n.getMessage("settingsEnableByDomainSmartProfileNonEditable").replace("{0}", smartProfile.profileName),
				rule: null
			};
		}

		// Find the rule by ID
		let rule = ProfileRules.getRuleById(smartProfile, ruleId);
		if (rule == null) {
			return {
				success: false,
				message: "Rule not found",
				rule: null
			};
		}

		// Validate proxy server ID and get proxy server object
		let proxyServer: ProxyServer = null;
		if (proxyServerId === ProxyRuleSpecialProxyServer.DefaultGeneral || 
			proxyServerId === ProxyRuleSpecialProxyServer.ProfileProxy) {
			// Special proxy server IDs - proxy should be null
			proxyServer = null;
		} else {
			// Check if it's a valid proxy server
			proxyServer = SettingsOperation.findProxyServerById(proxyServerId);
			if (proxyServer == null) {
				return {
					success: false,
					message: "Invalid proxy server ID",
					rule: null
				};
			}
		}

		// Update both proxy server ID and proxy object
		rule.proxyServerId = proxyServerId;
		rule.proxy = proxyServer;

		return {
			success: true,
			message: null,
			rule: rule
		};
	}

	private static enableByHostnameInternal(smartProfile: SmartProfile, hostname: string): {
		success: boolean,
		message: string,
		rule: ProxyRule
	} {
		// current url should be valid
		if (!Utils.isNotInternalHostName(hostname))
			// The selected domain is not valid
			return {
				success: false,
				message: api.i18n.getMessage("settingsEnableByDomainInvalid"),
				rule: null
			};

		// the domain should be the source
		let rule = ProfileRules.getRuleByHostname(smartProfile, hostname);

		if (rule != null) {
			// Rule for the domain already exists
			return {
				success: true,
				message: api.i18n.getMessage("settingsEnableByDomainExists"),
				rule: rule
			};
		}

		rule = ProfileRules.addRuleByHostname(smartProfile, hostname);

		return {
			success: true,
			message: null,
			rule: rule
		};
	}

	private static getRuleById(smartProfile: SmartProfile, ruleId: number) {
		return smartProfile.proxyRules.find(rule => rule.ruleId == ruleId);
	}

	private static getRuleByHostname(smartProfile: SmartProfile, hostName: string) {
		return smartProfile.proxyRules.find(rule => rule.hostName == hostName);
	}

	private static toggleRuleByHostname(smartProfile: SmartProfile, hostName: string) {

		// the domain should be the source
		let rule = ProfileRules.getRuleByHostname(smartProfile, hostName);

		if (rule == null) {
			if (!Utils.isNotInternalHostName(hostName))
				// this is an extra check!
				return;

			ProfileRules.addRuleByHostname(smartProfile, hostName);
		} else {
			ProfileRules.removeRule(smartProfile, rule);
		}
	}

	private static addRuleByHostname(smartProfile: SmartProfile, hostname: string): ProxyRule {

		let rule = new ProxyRule();
		rule.ruleType = ProxyRuleType.DomainSubdomain;
		rule.ruleSearch = hostname;
		rule.autoGeneratePattern = true;
		rule.hostName = hostname;
		rule.enabled = true;
		rule.proxy = null;

		if (smartProfile.profileTypeConfig.defaultRuleActionIsWhitelist == true)
			// NOTE: in AlwaysEnabled mode the default rule type is Whitelist
			rule.whiteList = true;

		// add and save it
		ProfileRules.addRule(smartProfile, rule);

		return rule;
	}

	private static addRule(smartProfile: SmartProfile, rule: ProxyRule) {

		do {
			// making sure the ruleId is unique
			var isDuplicateRuleId = smartProfile.proxyRules.some(r => r.ruleId == rule.ruleId);

			if (isDuplicateRuleId)
				rule.ruleId = Utils.getNewUniqueIdNumber();
		} while (isDuplicateRuleId);

		smartProfile.proxyRules.push(rule);
	}

	private static removeRule(smartProfile: SmartProfile, rule: ProxyRule) {
		let itemIndex = smartProfile.proxyRules.indexOf(rule);
		if (itemIndex > -1) {
			smartProfile.proxyRules.splice(itemIndex, 1);
		}
	}

	/** Enable hostname with auto-add of related URLs based on settings */
	public static enableByHostnameWithAutoAdd(hostname: string, tabId?: number): {
		success: boolean,
		message: string,
		rule: ProxyRule,
		autoAddedCount: number
	} {
		// First, add the main rule
		let result = ProfileRules.enableByHostname(hostname);
		if (!result.success) {
			return {
				...result,
				autoAddedCount: 0
			};
		}

		let autoAddedCount = 0;
		let options = Settings.current?.options;

		// Check if auto-add options are enabled
		if (!options?.autoAddThirdPartyDomains && !options?.autoAddFullUrlPaths) {
			return {
				...result,
				autoAddedCount: 0
			};
		}

		// Get loaded URLs from tab
		if (tabId == null) {
			return {
				...result,
				autoAddedCount: 0
			};
		}

		let tabData = TabManager.getTab(tabId);
		if (!tabData) {
			return {
				...result,
				autoAddedCount: 0
			};
		}

		let loadedUrls = tabData.getLoadedUrls();
		if (!loadedUrls || loadedUrls.length === 0) {
			return {
				...result,
				autoAddedCount: 0
			};
		}

		let smartProfile = ProfileOperations.getActiveSmartProfile();
		if (!smartProfile) {
			return {
				...result,
				autoAddedCount: 0
			};
		}

		// Extract main domain for third-party detection
		let mainDomain = ProfileRules.extractRootDomain(hostname);
		let domainsToAdd = new Set<string>();

		for (let url of loadedUrls) {
			try {
				let urlObj = new URL(url);
				let urlHost = urlObj.hostname;

				// Skip if same as main hostname
				if (urlHost === hostname) {
					continue;
				}

				// Option A: Auto-add third-party domains
				if (options.autoAddThirdPartyDomains) {
					let urlRootDomain = ProfileRules.extractRootDomain(urlHost);
					// Only add if it's a third-party domain (different root domain)
					if (urlRootDomain && urlRootDomain !== mainDomain) {
						if (Utils.isNotInternalHostName(urlHost)) {
							domainsToAdd.add(urlHost);
						}
					}
				}

				// Option B: Auto-add full URL paths
				if (options.autoAddFullUrlPaths) {
					// Add the full path as a rule pattern
					let fullPath = urlHost + urlObj.pathname;
					if (Utils.isNotInternalHostName(urlHost)) {
						domainsToAdd.add(fullPath);
					}
				}
			} catch (e) {
				// Invalid URL, skip
				continue;
			}
		}

		// Add rules for extracted domains (no limit - add all)
		for (let domain of domainsToAdd) {
			// Check if rule already exists
			let existingRule = ProfileRules.getRuleByHostname(smartProfile, domain);
			if (!existingRule) {
				ProfileRules.addRuleByHostname(smartProfile, domain);
				autoAddedCount++;
			}
		}

		return {
			success: true,
			message: result.message,
			rule: result.rule,
			autoAddedCount: autoAddedCount
		};
	}

	/** Extract root domain from hostname (e.g., 'www.example.com' -> 'example.com') */
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

		// Common TLDs that have second-level domains (e.g., co.uk, com.au)
		const twoPartTlds = ['co.uk', 'com.au', 'co.nz', 'co.jp', 'com.cn', 'co.in', 'gov.uk', 'ac.uk', 'edu.au'];
		let lastTwoParts = parts.slice(-2).join('.');

		if (twoPartTlds.includes(lastTwoParts)) {
			// Return last 3 parts
			return parts.slice(-3).join('.');
		}

		// Return last 2 parts for normal TLDs
		return parts.slice(-2).join('.');
	}
}