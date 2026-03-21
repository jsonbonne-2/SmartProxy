# SmartProxy 性能优化进度

## 概述

基于原仓库 `salarcode/SmartProxy` 新增 9 个 commit，专注于 Chrome PAC 脚本性能优化。

## Commit 详情

### 1. ac6329a - perf: add caching and auto-add proxy features
- 初始性能优化基础

### 2. 40e3ea8 - perf: add Trie/HashMap for faster rule matching
- 添加 Trie 树结构用于域名匹配
- 添加 HashMap 用于快速查找

### 3. a2c6032 - perf: add HashMaps to Chrome PAC for O(1) lookups
- PAC 脚本中实现 O(1) HashMap 查找
- `exactDomainMap`: 精确域名匹配
- `exactUrlMap`: 精确 URL 匹配
- `domainPathMap`: 域名+路径前缀匹配

### 4. aef38e7 - perf: add fast-path domain caching
- 快速路径域名缓存
- 减少重复规则检查

### 5. a88fe17 - perf: add subdomain auto-matching to domain cache
- 子域名自动匹配
- 父域名规则自动应用于子域名

### 6. 4cd5988 - fix: prevent cache pollution in rule matching
- 修复规则匹配缓存污染问题
- 确保不同规则集缓存隔离

### 7. ab8dcdd - fix: skip failed requests for whitelisted domains
- 修复子域名不遵守父域名白名单规则的问题
- 当父域名在白名单时，子域名的失败请求不再追踪

### 8. ca5142a - perf: O(k) subdomain matching via suffixMap
- 添加 `subdomainSuffixMap` 实现子域名 O(k) 查找
- `SearchDomainSubdomain` 规则从数组移到 HashMap
- 子域名匹配从 O(n) 线性搜索降为 O(k) 后缀查找

### 9. c127c76 - perf: add performance logging to PAC script
- 添加性能统计日志
- 统计 fastPath/slowPath 命中率
- 各步骤耗时分布（exactDomain, exactUrl, domainPath, subdomainSuffix, ruleMatch）

### 10. aee3799 - perf: lower log threshold and add console output
- 降低日志阈值到 10 次请求
- 添加 console.log 备用输出

### 11. 31c3ae8 - perf: add negative cache for no-match domains
- 添加 `negativeCache` 缓存无匹配规则的域名
- 后续请求跳过 O(n×r) 正则匹配，直接返回 DIRECT
- 缓存上限 1000 个域名防止内存膨胀

## 当前优化状态

| 路径 | 优化机制 | 复杂度 |
|------|----------|--------|
| Chrome PAC | exactDomainMap | O(1) |
| Chrome PAC | exactUrlMap | O(1) |
| Chrome PAC | domainPathMap | O(m) |
| Chrome PAC | subdomainSuffixMap | O(k) |
| Chrome PAC | negativeCache | O(1) |
| Chrome PAC | regex 规则 | O(n×r) |

## 下一步计划

1. ~~分析性能日志数据，识别瓶颈~~ (PAC 日志需在 Service Worker 控制台查看)
2. ~~实现 PAC 内置负向缓存（已知无规则的域名）~~ ✅ 已完成
3. 如果 `ruleMatch` 耗时高 → 优化正则规则匹配（考虑预编译正则索引）
4. 考虑将 negativeCache 持久化到 chrome.storage.session

## 文件变更

- `src/core/ProxyEngineChrome.ts` - PAC 脚本优化
- `src/core/ProxyRules.ts` - 规则匹配缓存
- `src/core/WebFailedRequestMonitor.ts` - 白名单子域名修复