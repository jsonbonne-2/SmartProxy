/*
 * This file is part of SmartProxy <https://github.com/salarcode/SmartProxy>,
 * Copyright (C) 2023 Salar Khalilzadeh <salar2k@gmail.com>
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
import { Debug } from "../lib/Debug";
import { ProxyRuleType, CompiledProxyRule, ProxyRule, CompiledProxyRuleType, SubscriptionProxyRule, CompiledProxyRuleSource, CompiledProxyRulesInfo, CompiledProxyRulesMatchedSource, ProxyRuleSpecialProxyServer, SmartProfileBase } from "./definitions";
import { Utils } from "../lib/Utils";
import { SettingsOperation } from "./SettingsOperation";
import { api } from "../lib/environment";

export class ProxyRules {
	/** Cache for URL matching results to speed up repeated requests */
	private static urlMatchCache: Map<string, {
		compiledRule: CompiledProxyRule,
		matchedRuleSource: CompiledProxyRulesMatchedSource
	} | null> = new Map();
	/** Cache for single rule matching (used by Firefox handleProxyRequest) */
	private static singleRuleMatchCache: Map<string, {
		rule: CompiledProxyRule | null,
		rulesRef: CompiledProxyRule[]
	}> = new Map();
	/** Max cache size */
	private static readonly MAX_CACHE_SIZE = 2000;

	public static compileRules(profile: SmartProfileBase, proxyRules: ProxyRule[]): {
		compiledList: CompiledProxyRule[],
		compiledWhiteList: CompiledProxyRule[]
	} {
		if (!proxyRules)
			return;

		let compiledList: CompiledProxyRule[] = [];
		let compiledWhiteList: CompiledProxyRule[] = [];

		for (let i = 0; i < proxyRules.length; i++) {
			const rule = proxyRules[i];

			if (!rule.enabled)
				continue;

			let newCompiled = new CompiledProxyRule();

			newCompiled.ruleId = rule.ruleId;
			newCompiled.whiteList = rule.whiteList;
			newCompiled.hostName = rule.hostName;
			newCompiled.proxy = rule.proxy;
			if (rule.proxyServerId == ProxyRuleSpecialProxyServer.DefaultGeneral) {
				newCompiled.proxy = null;
			} else if (rule.proxyServerId == ProxyRuleSpecialProxyServer.ProfileProxy) {
				if (profile.profileProxyServerId) {
					// the proxy is derived from profile
					let profileProxy = SettingsOperation.findProxyServerById(profile.profileProxyServerId);
					if (profileProxy) {
						newCompiled.proxy = profileProxy;
					}
				}
			}

			newCompiled.compiledRuleSource = CompiledProxyRuleSource.Rules;

			switch (rule.ruleType) {
				case ProxyRuleType.Exact:
					newCompiled.search = rule.ruleExact.toLowerCase();
					newCompiled.compiledRuleType = CompiledProxyRuleType.Exact;
					break;

				case ProxyRuleType.DomainSubdomain:
					newCompiled.search = rule.ruleSearch.toLowerCase();
					newCompiled.compiledRuleType = CompiledProxyRuleType.SearchDomainSubdomain;
					break;

				case ProxyRuleType.MatchPatternHost:
					{
						let regex = Utils.matchPatternToRegExp(rule.rulePattern, false, true);
						if (regex == null)
							continue;
						newCompiled.regex = regex;
						newCompiled.compiledRuleType = CompiledProxyRuleType.RegexHost;
					}
					break;

				case ProxyRuleType.MatchPatternUrl:
					{
						let regex = Utils.matchPatternToRegExp(rule.rulePattern, true, false);
						if (regex == null)
							continue;
						newCompiled.regex = regex;
						newCompiled.compiledRuleType = CompiledProxyRuleType.RegexUrl;
					}
					break;

				case ProxyRuleType.RegexHost:
					{
						// This simple construction is good enough. TODO: This ^(?:)$ is not needed?
						newCompiled.regex = new RegExp(rule.ruleRegex, "i");
						newCompiled.compiledRuleType = CompiledProxyRuleType.RegexHost;
					}
					break;

				case ProxyRuleType.RegexUrl:
					{
						// This simple construction is good enough. TODO: This ^(?:)$ is not needed?
						newCompiled.regex = new RegExp(rule.ruleRegex);
						newCompiled.compiledRuleType = CompiledProxyRuleType.RegexUrl;
					}
					break;

				case ProxyRuleType.DomainExact:
					newCompiled.search = rule.ruleSearch.toLowerCase();
					newCompiled.compiledRuleType = CompiledProxyRuleType.SearchDomain;
					break;

				case ProxyRuleType.DomainAndPath:
					newCompiled.search = rule.ruleSearch.toLowerCase();
					newCompiled.compiledRuleType = CompiledProxyRuleType.SearchDomainAndPath;
					break;

				case ProxyRuleType.DomainSubdomainAndPath:
					newCompiled.search = rule.ruleSearch.toLowerCase();
					newCompiled.compiledRuleType = CompiledProxyRuleType.SearchDomainSubdomainAndPath;
					break;

				case ProxyRuleType.SearchUrl:
					newCompiled.search = rule.ruleSearch.toLowerCase();
					newCompiled.compiledRuleType = CompiledProxyRuleType.SearchUrl;
					break;

				case ProxyRuleType.IpCidrNotation:
					{
						let regex = Utils.ipCidrNotationToRegExp(rule.ruleSearch, rule.rulePattern);
						if (regex == null) {
							Debug.warn(`Failed to compile CIDR rule ${rule.ruleSearch}/${rule.rulePattern} to regex`, rule);
							continue;
						}
						newCompiled.regex = regex;
						newCompiled.compiledRuleType = CompiledProxyRuleType.RegexHost;
					}
					break;

				default:
					continue;
			}
			if (rule.whiteList) {
				compiledWhiteList.push(newCompiled);
			}
			else
				compiledList.push(newCompiled);
		}

		return {
			compiledList,
			compiledWhiteList
		};
	}

	public static compileRulesSubscription(rules: SubscriptionProxyRule[], markAsWhitelisted: boolean = null): CompiledProxyRule[] {
		if (!rules)
			return [];

		let compiledList: CompiledProxyRule[] = [];
		for (const rule of rules) {

			let newCompiled = new CompiledProxyRule();
			newCompiled.search = rule.search;
			newCompiled.compiledRuleSource = CompiledProxyRuleSource.Subscriptions;

			if (markAsWhitelisted === true)
				newCompiled.whiteList = true;

			newCompiled.compiledRuleType = rule.importedRuleType;

			switch (rule.importedRuleType) {
				case CompiledProxyRuleType.RegexHost:
					newCompiled.regex = new RegExp(rule.regex, "i");
					break;

				case CompiledProxyRuleType.RegexUrl:
					newCompiled.regex = new RegExp(rule.regex);
					break;

				case CompiledProxyRuleType.Exact:
				case CompiledProxyRuleType.SearchUrl:
				case CompiledProxyRuleType.SearchDomain:
				case CompiledProxyRuleType.SearchDomainSubdomain:
				case CompiledProxyRuleType.SearchDomainAndPath:
				case CompiledProxyRuleType.SearchDomainSubdomainAndPath:
					break;

				default:
					Debug.error('compileRulesSubscription: Invalid importedRuleType of ' + rule.importedRuleType);
					continue;
			}
			compiledList.push(newCompiled);
		}

		return compiledList;
	}

	public static findMatchedDomainListInRulesInfo(domainList: string[], compiledRules: CompiledProxyRulesInfo): {
		compiledRule: CompiledProxyRule,
		matchedRuleSource: CompiledProxyRulesMatchedSource
	}[] {
		let result = [];
		for (const domain of domainList) {

			let matchResult = ProxyRules.findMatchedDomainInRulesInfo(domain, compiledRules);
			result.push(matchResult);
		}

		return result;
	}

	public static findMatchedDomainInRulesInfo(searchDomain: string, compiledRules: CompiledProxyRulesInfo): {
		compiledRule: CompiledProxyRule,
		matchedRuleSource: CompiledProxyRulesMatchedSource
	} | null {
		let url = searchDomain.toLowerCase();
		if (!url.includes(":/"))
			url = "http://" + url;

		return ProxyRules.findMatchedUrlInRulesInfo(url, compiledRules);
	}

	public static findMatchedUrlInRulesInfo(searchUrl: string, compiledRules: CompiledProxyRulesInfo): {
		compiledRule: CompiledProxyRule,
		matchedRuleSource: CompiledProxyRulesMatchedSource
	} | null {
		// Check cache first
		let cacheKey = searchUrl.toLowerCase();
		if (cacheKey.length < 500) { // Don't cache very long URLs
			let cachedResult = ProxyRules.urlMatchCache.get(cacheKey);
			if (cachedResult !== undefined) {
				return cachedResult;
			}
		}

		// user skip the bypass rules
		let userWhitelistMatchedRule = ProxyRules.findMatchedUrlInRules(searchUrl, compiledRules.WhitelistRules)
		if (userWhitelistMatchedRule) {
			let result = {
				compiledRule: userWhitelistMatchedRule,
				matchedRuleSource: CompiledProxyRulesMatchedSource.WhitelistRules
			};
			ProxyRules.addToCache(cacheKey, result);
			return result;
		}

		// user bypass rules
		let userMatchedRule = ProxyRules.findMatchedUrlInRules(searchUrl, compiledRules.Rules);
		if (userMatchedRule) {
			let result = {
				compiledRule: userMatchedRule,
				matchedRuleSource: CompiledProxyRulesMatchedSource.Rules
			};
			ProxyRules.addToCache(cacheKey, result);
			return result;
		}

		// subscription skip bypass rules
		let subWhitelistMatchedRule = ProxyRules.findMatchedUrlInRules(searchUrl, compiledRules.WhitelistSubscriptionRules)
		if (subWhitelistMatchedRule) {
			let result = {
				compiledRule: subWhitelistMatchedRule,
				matchedRuleSource: CompiledProxyRulesMatchedSource.WhitelistSubscriptionRules
			};
			ProxyRules.addToCache(cacheKey, result);
			return result;
		}

		// subscription bypass rules
		let subMatchedRule = ProxyRules.findMatchedUrlInRules(searchUrl, compiledRules.SubscriptionRules);
		if (subMatchedRule) {
			let result = {
				compiledRule: subMatchedRule,
				matchedRuleSource: CompiledProxyRulesMatchedSource.SubscriptionRules
			};
			ProxyRules.addToCache(cacheKey, result);
			return result;
		}

		// Cache negative result (no match)
		ProxyRules.addToCache(cacheKey, null);
		return null;
	}

	/** Add result to cache with size limit */
	private static addToCache(key: string, result: {
		compiledRule: CompiledProxyRule,
		matchedRuleSource: CompiledProxyRulesMatchedSource
	} | null) {
		if (key.length >= 500) return; // Don't cache very long URLs

		if (ProxyRules.urlMatchCache.size >= ProxyRules.MAX_CACHE_SIZE) {
			// Clear half the cache when full
			const keys = Array.from(ProxyRules.urlMatchCache.keys());
			for (let i = 0; i < keys.length / 2; i++) {
				ProxyRules.urlMatchCache.delete(keys[i]);
			}
		}
		ProxyRules.urlMatchCache.set(key, result);
	}

	/** Clear the URL match cache (call when rules change) */
	public static clearMatchCache() {
		ProxyRules.urlMatchCache.clear();
		ProxyRules.singleRuleMatchCache.clear();
	}

	public static findMatchedDomainRule(searchDomain: string, rules: CompiledProxyRule[]): CompiledProxyRule | null {
		let url = searchDomain.toLowerCase();
		if (!url.includes(":/"))
			url = "http://" + url;

		return ProxyRules.findMatchedUrlInRules(url, rules);
	}

	public static findMatchedUrlInRules(searchUrl: string, rules: CompiledProxyRule[]): CompiledProxyRule | null {
		if (rules == null || rules.length == 0)
			return null;

		// Use lowercase for cache key consistency
		let lowerCaseUrl = searchUrl.toLowerCase();

		// Check single-rule cache (for Firefox handleProxyRequest which calls this multiple times)
		let cacheKey = lowerCaseUrl;
		if (cacheKey.length < 500) {
			let cachedResult = ProxyRules.singleRuleMatchCache.get(cacheKey);
			if (cachedResult !== undefined && cachedResult.rulesRef === rules) {
				return cachedResult.rule;
			}
		}

		let result: CompiledProxyRule | null = null;
		let domainHostLowerCase: string;
		let schemaLessUrlLowerCase: string;

		try {
			for (let rule of rules) {

				switch (rule.compiledRuleType) {
					case CompiledProxyRuleType.SearchDomainSubdomain:

						if (domainHostLowerCase == null) {
							domainHostLowerCase = Utils.extractHostNameFromUrl(lowerCaseUrl);
							if (domainHostLowerCase == null) {
								continue;
							}
						}
						// domain
						if (domainHostLowerCase == rule.search) {
							result = rule;
							break;
						}

						// subdomains
						if (domainHostLowerCase.endsWith('.' + rule.search)) {
							result = rule;
							break;
						}

						break;

					case CompiledProxyRuleType.SearchDomainSubdomainAndPath:

						if (schemaLessUrlLowerCase == null) {
							schemaLessUrlLowerCase = Utils.removeSchemaFromUrl(lowerCaseUrl);
							if (schemaLessUrlLowerCase == null) {
								continue;
							}
						}
						if (schemaLessUrlLowerCase.startsWith(rule.search)) {
							result = rule;
							break;
						}

						let ruleSearchHost = Utils.extractHostNameFromInvalidUrl(rule.search);
						if (ruleSearchHost != null) {

							if (domainHostLowerCase == null) {
								domainHostLowerCase = Utils.extractHostNameFromUrl(lowerCaseUrl);
								if (domainHostLowerCase == null) {
									continue;
								}
							}

							// should be the same
							if (ruleSearchHost != domainHostLowerCase && !domainHostLowerCase.endsWith('.' + ruleSearchHost))
								continue;

							// after this state, we are sure that the url is for the same domain, now just checking the path
						}

						// subdomains
						if (schemaLessUrlLowerCase.includes('.' + rule.search)) {
							result = rule;
							break;
						}
						break;

					case CompiledProxyRuleType.SearchDomainAndPath:

						if (schemaLessUrlLowerCase == null) {
							schemaLessUrlLowerCase = Utils.removeSchemaFromUrl(lowerCaseUrl);
							if (schemaLessUrlLowerCase == null) {
								continue;
							}
						}
						if (schemaLessUrlLowerCase.startsWith(rule.search)) {
							result = rule;
							break;
						}

						break;

					case CompiledProxyRuleType.SearchUrl:

						if (lowerCaseUrl.startsWith(rule.search)) {
							result = rule;
							break;
						}
						break;

					case CompiledProxyRuleType.RegexUrl:
						// Using original url with case sensitivity
						if (rule.regex.test(searchUrl)) {
							result = rule;
							break;
						}
						break;

					case CompiledProxyRuleType.RegexHost:

						if (domainHostLowerCase == null) {
							domainHostLowerCase = Utils.extractHostNameFromUrl(lowerCaseUrl);
							if (domainHostLowerCase == null) {
								continue;
							}
						}

						if (rule.regex.test(domainHostLowerCase)) {
							result = rule;
							break;
						}
						break;

					case CompiledProxyRuleType.SearchDomain:

						if (domainHostLowerCase == null) {
							domainHostLowerCase = Utils.extractHostNameFromUrl(lowerCaseUrl);
							if (domainHostLowerCase == null) {
								continue;
							}
						}
						if (rule.search == domainHostLowerCase) {
							result = rule;
							break;
						}
						break;

					case CompiledProxyRuleType.Exact:

						if (lowerCaseUrl == rule.search) {
							result = rule;
							break;
						}
						break;
				}
				if (result) break;
			}

			// if we have reached here no rule matched, but we might have a rule with domain and port
			// if we had a rule with domain, we need to check for port as well
			if (!result && domainHostLowerCase != null) {
				let domainHostWithPort = Utils.extractHostFromUrl(lowerCaseUrl);

				if (domainHostWithPort != domainHostLowerCase) {

					// host has port part, doing a recheck
					domainHostLowerCase = domainHostWithPort;

					for (let rule of rules) {

						// NOTE: Only rules that work on hostName should be checked, others can be ignored
						switch (rule.compiledRuleType) {

							case CompiledProxyRuleType.SearchDomainSubdomain:

								// domain
								if (domainHostLowerCase == rule.search) {
									result = rule;
									break;
								}

								// subdomains
								if (domainHostLowerCase.endsWith('.' + rule.search)) {
									result = rule;
									break;
								}

								break;

							case CompiledProxyRuleType.SearchDomainSubdomainAndPath:

								if (schemaLessUrlLowerCase == null) {
									schemaLessUrlLowerCase = Utils.removeSchemaFromUrl(lowerCaseUrl);
									if (schemaLessUrlLowerCase == null) {
										continue;
									}
								}
								if (schemaLessUrlLowerCase.startsWith(rule.search)) {
									result = rule;
									break;
								}

								let ruleSearchHost = Utils.extractHostFromInvalidUrl(rule.search);
								if (ruleSearchHost != null) {
									// should be the same
									if (ruleSearchHost != domainHostLowerCase && !domainHostLowerCase.endsWith('.' + ruleSearchHost))
										continue;

									// after this state, we are sure that the url is for the same domain, now just checking the path
								}

								// subdomains
								if (schemaLessUrlLowerCase.includes('.' + rule.search)) {
									result = rule;
									break;
								}
								break;

							case CompiledProxyRuleType.RegexHost:

								if (rule.regex.test(domainHostLowerCase)) {
									result = rule;
									break;
								}
								break;

							case CompiledProxyRuleType.SearchDomain:

								if (rule.search == domainHostLowerCase) {
									result = rule;
									break;
								}
								break;

							case CompiledProxyRuleType.Exact:
							case CompiledProxyRuleType.RegexUrl:
							case CompiledProxyRuleType.SearchUrl:
							case CompiledProxyRuleType.SearchDomainAndPath:
								break;
						}
						if (result) break;
					}
				}
			}
		} catch (e) {
			Debug.warn(`findMatchForUrl failed for ${searchUrl}`, e);
		}

		// Cache the result for this URL+rules combination
		if (cacheKey.length < 500) {
			ProxyRules.addSingleRuleToCache(cacheKey, result, rules);
		}
		return result;
	}

	/** Add result to single-rule cache with size limit */
	private static addSingleRuleToCache(key: string, rule: CompiledProxyRule | null, rulesRef: CompiledProxyRule[]) {
		if (key.length >= 500) return;

		if (ProxyRules.singleRuleMatchCache.size >= ProxyRules.MAX_CACHE_SIZE) {
			// Clear half the cache when full
			const keys = Array.from(ProxyRules.singleRuleMatchCache.keys());
			for (let i = 0; i < keys.length / 2; i++) {
				ProxyRules.singleRuleMatchCache.delete(keys[i]);
			}
		}
		ProxyRules.singleRuleMatchCache.set(key, { rule, rulesRef });
	}

	public static validateRule(rule: ProxyRule): {
		success: boolean, exist?: boolean, message?: string,
		result?: any
	} {
		if (rule.hostName) {
			if (!Utils.isNotInternalHostName(rule.hostName)) {
				// 'source' is not valid '${rule.source}
				return { success: false, message: api.i18n.getMessage("settingsRuleSourceInvalidFormat").replace("{0}", rule.hostName) };
			}
		}

		if (!rule.rule)
			// Rule doesn't have pattern defined
			return { success: false, message: api.i18n.getMessage("settingsRulePatternIsEmpty") };

		if (rule["enabled"] == null)
			rule.enabled = true;

		return { success: true };
	}
}