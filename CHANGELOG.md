# Changelog

本项目的所有显著变更都将记录在此文件中。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.1.0] - 2026-06-23

### 修复

- **修复手动关闭阅后即焚后，到达原定过期时间仍会再次触发结束流程的问题。** 此前 `scheduleExpiration` 注册的 `ctx.setTimeout` 句柄被丢弃，手动关闭命令无法取消该定时器；当 bot 在原 `expiresAt` 之前持续稳定运行时，过期回调会在到点时再次发送 "用户 xxx 的阅后即焚已过期" 通知，并重复执行一遍批量撤回流程。该 bug 自 1.0.0 起一直存在，只是在 bot 频繁重启 / 插件 reload 的场景下会被 ctx dispose 自动清理掉而难以观察。

### 新增

- 新增内部 `expirationTimers` Map 用于追踪每个用户的过期定时器 `dispose` 句柄。
- 新增 `cancelExpirationTimer(userId, guildId)` 辅助函数，统一处理定时器取消逻辑。
- `scheduleExpiration` 注册新定时器前会先取消同 key 的旧定时器，防止重复登记。
- 过期回调内新增 `burn_after_reading_users` 表存在性兜底校验，确保即使定时器追踪状态出现异常，也不会对已手动关闭的用户重复执行过期流程。

### 内部变更

- `burnAfterReading` 函数入口统一调用 `cancelExpirationTimer`，覆盖手动关闭、过期自然触发、`ready` 钩子过期补偿三条调用路径。

## [1.0.3] - 2026-01-02

### 变更

- 优化"开启阅后即焚"成功后的提示文案，引导用户使用"关闭阅后即焚"命令手动触发撤回。

## [1.0.2] - 2026-01-02

### 修复

- 修正存储通知消息时 `sentAt` 字段使用旧时间戳的问题，改为消息实际发送时刻。

### 内部变更

- 清理源码中多处行尾空格。
- 补充 LICENSE 文件。

## [1.0.1] - 2025-11-19

### 文档

- 更新 README 与 `package.json` 元信息。

## [1.0.0] - 2025-11-19

### 新增

- 首个正式版本，提供阅后即焚核心功能：
  - `阅后即焚.开启` / `开启阅后即焚`：开启当前群组的阅后即焚模式。
  - `阅后即焚.关闭` / `关闭阅后即焚`：手动关闭并触发批量撤回。
- 配置项：`recallDelay`、`maxDuration`、`maxUsers`、`batchRecallInterval`。
- 基于 OneBot 适配器的群成员权限校验（bot 与用户角色检查）。
- 数据库表 `burn_after_reading_users` 与 `burn_after_reading_messages` 持久化用户状态与消息记录。
- 插件 `ready` 钩子在启动时恢复未过期用户的定时器、并对已过期用户触发批量撤回。

[1.1.0]: https://github.com/inscripoem/koishi-plugin-burn-after-reading/compare/v1.0.3...v1.1.0
[1.0.3]: https://github.com/inscripoem/koishi-plugin-burn-after-reading/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/inscripoem/koishi-plugin-burn-after-reading/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/inscripoem/koishi-plugin-burn-after-reading/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/inscripoem/koishi-plugin-burn-after-reading/releases/tag/v1.0.0
