# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# SmartProxy

Browser extension that automatically enables/disables proxy based on URL patterns. Supports Firefox, Chrome, Edge, Opera, Thunderbird.

## Build Commands

```bash
npm run build-ff          # Firefox
npm run build-ff:watch    # Firefox (dev mode)
npm run build-ch          # Chrome MV3 (service worker)
npm run build-ch:watch    # Chrome (dev mode)
npm run build-ed          # Edge
npm run build-op          # Opera
npm test                  # Run Jest tests
npm run test:watch        # Watch mode
npm run lint              # ESLint
```

## Architecture

| Layer | Location | Purpose |
|-------|----------|---------|
| Core | `src/core/` | Extension logic, message handling, initialization |
| Browser Adapters | `src/core/browsers/` | Browser-specific proxy API implementations |
| Utilities | `src/lib/` | Cross-browser API abstraction, helpers |
| UI | `src/ui/code/` | Popup, settings page, proxyable resources |
| Tests | `src/tests/` | Jest unit tests |

## Entry Points

- **Background**: `src/core/Core.ts` → `src/core/browsers/{browser}.ts`
- **Service Worker** (Chrome MV3): `src/core/ServiceWorker/CoreServiceWorker.ts`
- **Popup**: `src/ui/code/popup.ts`
- **Settings**: `src/ui/code/settingsPage.ts`

## Key Concepts

- **Profiles**: Different proxy modes (Direct, SmartRules, AlwaysEnabled, SystemProxy, IgnoreFailureRules)
- **Rules**: Compiled patterns matching URLs to proxy decisions (regex, domain, exact, CIDR)
- **Subscriptions**: External proxy server lists and rule sets
- **Cross-browser API**: `src/lib/environment.ts` abstracts Chrome vs Firefox API differences

## Where to Look

| Task | Location |
|------|----------|
| Add proxy rule type | `src/core/definitions.ts` (ProxyRuleType enum) |
| Modify proxy matching logic | `src/core/ProxyRules.ts` |
| Add browser-specific behavior | `src/core/browsers/{browser}.ts` |
| Change settings schema | `src/core/Settings.ts`, `src/core/definitions.ts` |
| Add UI page | `src/ui/code/` + webpack.config.js entry |
| Add utility function | `src/lib/Utils.ts` |
| Write tests | `src/tests/` |

## Browser Differences

Chrome MV3 uses service worker (`service_worker=true` in build). Firefox uses background page. The `environment.ts` module detects browser and exposes `api` (chrome/browser) and `environment` object with feature flags.

**Note: This project only optimizes Chrome-related code.** Performance optimizations focus on `ProxyEngineChrome.ts` (PAC script) and Chrome MV3 service worker.

## Agent Workflow

Explore finds → Librarian reads → You plan → Worker implements → Validator checks