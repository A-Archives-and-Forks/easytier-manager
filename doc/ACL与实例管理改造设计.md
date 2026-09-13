# 改造设计文档：ACL 访问控制 + 实例运行时管理 + 配置校验

> 分支：`feat/config`；核心版本基准：easytier-core 2.6.4 需求来源：2026-09-13 功能差距检查（详见会话结论），已确认的决策：
>
> 1. ACL 做完整编辑器（组/密钥声明 + 链 + 规则，含协议/端口/IP/优先级/限速）
> 2. CLI 运行时管理新增「实例管理」页（顶部选实例 + Tab 分组）
> 3. 运行时修改采用**手动回写按钮**持久化到 TOML
> 4. 接入 `--check-config` 校验（已实测：未知自定义键如 `config_exit_nodes_route` 会被核心容忍，不会误报）
> 5. 不加 `--disable-env-parsing`；不做环境变量配置、`--daemon`、`--config-dir`
> 6. 类型同步小修一并处理

---

## 一、类型同步修复（小）

**文件**：`src/types/easyTier.ts`、`src/constants/defaultData.ts`

1. `EasyTierConfig` 补充缺失声明（实际序列化中已存在，仅类型缺）：
   - `port_forward?: PortForwardRule[]`（新增 `interface PortForwardRule { bind_addr: string; dst_addr: string; proto: string }`）
   - `mapped_listeners?: string[]`
2. `Flags`（easyTier.ts 侧）补齐 formTypes/defaultData 已在用但未声明的字段： `data_compress_algo?`、`compression_algorithm?`、`relay_network_whitelist?`、`accept_dns?`、`bind_device?`、`socks5?`、`enable_ipv6?`
3. 清理：
   - `stun_server: string[]`（保留兼容）改为可选 `stun_server?: string[]`，`flags_struct` 字段无任何引用，删除。
   - `defaultData.ts` 中死字段 `flags.compression_algorithm` 删除（UI 绑定的是 `data_compress_algo`，见 Form.vue:729）。
4. ACL 类型定义（见第四节）也加在本文件。

## 二、Rust 新命令：`check_config`

**文件**：`src-tauri/src/lib.rs`

背景：现有 `run_cli` 只返回 stdout 不返回退出码，而 `--check-config` 合法时静默退出 0、非法时静默退出 1，**无法靠输出区分**，必须拿退出码。

新增：

```rust
#[tauri::command(rename_all = "snake_case")]
fn check_config(app: AppHandle, program: String, config_path: String) -> CheckResult
// CheckResult { code: i32, stdout: String, stderr: String }
```

- 实现用 `std::process::Command::output()` 同步等待。
- macOS 沿用 `run_cli` 的路径校验模式：`program` 必须等于 `resource/current/easytier-core`（防任意路径执行）；Windows/Linux 用 `getCoreDir()` 返回的路径，前端传入。
- 注册进 `tauri::generate_handler!` 列表。

## 三、前端校验封装与接入点

**新文件**：`src/utils/configCheckUtil.ts`

```ts
export async function checkConfigFile(
  configFileName: string
): Promise<{ valid: boolean; message?: string }>
// 内部：configPath = join(await getConfigDir(), configFileName)
// invoke('check_config', { program: await getCoreDir(), configPath })
// code === 0 → valid；否则取出 stderr/stdout 中的错误信息（无输出时给通用提示）
```

接入点（4 处）：

| 接入点 | 位置 | 行为 |
| --- | --- | --- |
| 表单模式保存 | `views/config/index.vue` `addConfigAction` / 保存分支（写文件成功后） | 校验失败 → `ElNotification` warning 展示核心报错；文件仍保存（不阻塞编辑） |
| 原始文本模式保存 | 同文件两处 `dataConfig` 分支 | 同上 |
| 启动实例 | `utils/shellUtil.ts` `runEasyTierCore`（含 macOS 分支，在 `invoke('start_core_macos')` 之前） | 校验失败 → 不启动，返回 `{ code: 403, msg }`（沿用现有错误返回约定），调用方弹错 |
| 服务安装 | `shellUtil.ts` NSSM 安装（~640-716）与官方 `service install`（~792-872） | 安装前校验，失败中止并抛错给调用方 |

> 注：`runEasyTierCore` 返回值约定不变（成功返回 pid 字符串），调用方（`views/index/index.vue`）现有失败处理逻辑保持兼容，实现时核对调用方对返回值的判断分支。

## 四、ACL 完整编辑器

### 4.1 数据结构（`src/types/easyTier.ts`）

字段名严格按官方文档 `easytier.github.io/guide/config/acl.md`：

```ts
interface AclGroupDeclare {
  group_name: string
  group_secret: string
}
interface AclGroup {
  members?: string[]
  declares?: AclGroupDeclare[]
}
interface AclRule {
  name: string
  description?: string
  priority?: number // 0-65535，越大越先匹配
  action?: number // 0 无操作 / 1 允许 / 2 拒绝
  source_groups?: string[]
  destination_groups?: string[]
  source_ips?: string[] // CIDR，如 10.144.144.2/32
  destination_ips?: string[]
  protocol?: number // 0 未指定 / 1 TCP / 2 UDP / 3 ICMP / 4 ICMPv6 / 5 任何
  ports?: string[] // 如 ["3389"] / ["8000-9000"]
  source_ports?: string[]
  rate_limit?: number // bps，0 = 不限
  burst_limit?: number // bps
  stateful?: boolean
  enabled?: boolean
}
interface AclChain {
  name: string
  description?: string
  chain_type?: number // 0 未指定 / 1 入站 / 2 出站 / 3 转发(子网代理)
  default_action?: number // 1 允许 / 2 拒绝
  enabled?: boolean
  rules?: AclRule[]
}
interface AclV1 {
  group?: AclGroup
  chains?: AclChain[]
}
interface AclConfig {
  acl_v1: AclV1
}
```

`EasyTierConfig` / `EasyTierFormData` 增加 `acl?: AclConfig`。

### 4.2 序列化与清理

- 由 `smol-toml` 直接序列化为官方 TOML 形态： `[acl.acl_v1.group]`、`[[acl.acl_v1.group.declares]]`、`[[acl.acl_v1.chains]]`、`[[acl.acl_v1.chains.rules]]`（该结构已通过 2.6.4 `--check-config` 实测）。
- `defaultData.ts`：`acl: undefined` —— **默认完全不生成 `acl` 表**，旧配置文件不受影响。
- 清理规则（`config/index.vue` 保存前）：`acl` 下无任何 members/declares/chains 内容 → 置 `undefined`，不写入 TOML。
- 原始文本模式不受影响（用户可直接手写 `[acl.acl_v1]`，保存后有校验兜底）。

### 4.3 UI（`src/views/config/Form.vue`，端口转发分区之后新增「访问控制 (ACL)」分区）

- **分组身份卡片**：
  - `members`：`el-select multiple allow-create filterable`，直接绑定 `localFormData.acl.acl_v1.group.members`（本节点所属组名）。
  - `declares`：`el-table`（group_name / group_secret(password 输入) / 删除），底部「添加组声明」按钮。附提示文案：所有节点的 declares 必须完全一致。
- **链列表**：每条链一个 `el-card`：
  - 头部行：name、chain_type（select：未指定/入站/出站/转发）、default_action（select：允许/拒绝）、enabled 开关、description、删除链按钮。
  - 链内规则表 `el-table`，列：name、priority、action、protocol、ports、source_groups、destination_groups、enabled、操作（编辑/删除）。
  - 规则完整字段（IP 列表、源端口、限速、burst、stateful、description）通过「编辑」打开 `el-dialog` 表单维护，避免表格过挤。
- **空态**：分区顶部说明「不配置时该节不写入配置文件」；「添加链」「初始化分组」按钮按需创建结构。
- **i18n**：`easytier.acl*` 系列 key，zh-CN 与 en 同步补齐。

## 五、实例管理页（CLI 运行时管理）

### 5.1 文件与路由

- 新页面：`src/views/instance/index.vue`（Tab 内容较多时拆同目录子组件）。
- 路由：`src/router/index.ts` 新增 `/instance`，`name: 'InstanceManagement'`，meta title `t('router.instanceManagement')`，置于「网络总览」之后。

### 5.2 实例选择与调用约定

- 顶部 `el-select`：数据源复用 `listRunningCoreInstances()`（`utils/shellUtil.ts`），显示 `configFileName (rpcPortal)`，值取 `normalizeRpcPortal(inst.rpcPortal)`；无运行实例时显示空态引导。
- 所有调用统一走 `runEasyTierCli(['-p', portal, '-o', 'json', ...])`。
- 新增封装文件 `src/utils/instanceCliUtil.ts`：
  - 统一容错：`runEasyTierCli` 成功返回 string、失败返回 `{code,msg}` 对象 —— 封装 `cliJson<T>(args): Promise<T | null>` 与 `cliText(args): Promise<string>`，失败时返回 null 并由页面展示 msg。
  - json 解析失败时自动回退文本展示（部分子命令可能不支持 `-o json`）。

### 5.3 六个 Tab

| Tab | 读 | 操作（CLI） | 回写 TOML（手动按钮） |
| --- | --- | --- | --- |
| 白名单 | `whitelist show` | `whitelist set-tcp <ports>`、`set-udp <ports>`、`clear-tcp`、`clear-udp`（ports 为逗号分隔，如 `80,443,8000-9000`，与表单存储格式一致） | `tcp_whitelist` / `udp_whitelist`（字符串） |
| 端口转发 | `port-forward list` | `port-forward add <proto> <bind> <dst>`、`remove` | `port_forward` 数组整体覆盖 |
| 连接器 | `connector list` | `connector add <url>`、`remove <url>` | `peer` 数组 = 当前连接器 URL 列表（整体替换，操作前弹确认） |
| 临时凭据 | `credential list` | `credential generate --ttl <秒> [--groups][--reusable][--allow-relay][--allowed-proxy-cidrs]`、`credential revoke <id>` | 不回写（凭据是运行时签发的动态数据）；生成结果文本展示 + 复制 |
| 日志级别 | `logger get` | `logger set <disabled\|error\|warning\|info\|debug\|trace>` | `file_logger.level`（提示：完全生效需重启实例） |
| 诊断 | `stun`（NAT 类型）、`stats show`、`proxy`（KCP/TCP 代理状态） | 只读，文本/JSON 展示 + 刷新按钮 | 无 |

### 5.4 回写实现

- 新函数放 `src/utils/fileUtil.ts` 或 `instanceCliUtil.ts`： `readFileContent` → `smol-toml.parse` → 修改目标字段 → `stringify` → `writeFileContent`；只触碰目标字段，其余内容原样保留；文件路径 `CONFIG_PATH/<configFileName>.toml`。
- 每个可回写 Tab 提供「保存到配置文件」按钮；成功后 ElNotification 提示「已写入 <文件名>.toml」。

## 六、路由 / 导航 / i18n

- `src/router/index.ts`：新增 `/instance` 路由（第五节）。
- `src/locales/zh-CN.ts`、`src/locales/en.ts`：
  - `router.instanceManagement`
  - `easytier.acl*`（分组、声明、链、规则、协议/动作/链类型的枚举文案）
  - 实例管理页文案（tab 名、按钮、空态、回写提示）统一收在 `instance.*` 命名空间。

## 七、验证计划

1. `pnpm typecheck` / 现有 lint 脚本对改动文件；`cargo check`（src-tauri）。
2. 手动验证：
   - `--check-config`：含自定义键（`config_exit_nodes_route`）+ ACL 的 TOML 通过；故意写坏语法能被保存/启动校验拦截。
   - ACL：表单生成的 TOML 结构与官方文档 yaml 字段一一对应；`--check-config` 通过。
   - 实例管理：启动一个实例后逐 Tab 验证读/写/回写；未启动实例时空态。

## 八、风险与说明

1. **ACL 字段以官方文档为准**：`--check-config` 对未知键宽容，无法用二进制反推 schema；若核心后续版本调整字段名需复查（文档版本 2.4.3+，当前核心 2.6.4 满足）。
2. **CLI 输出格式**：部分子命令可能不支持 `-o json`，封装层统一回退文本展示，不影响功能。
3. **连接器回写**用「整体替换 `peer` 数组」的语义，UI 明确提示，避免用户误以为只追加。
4. `credential` 依赖核心的 ACL/凭据子系统，低版本核心可能无此子命令 —— 页面对 CLI 报错（未知命令）直接展示原始错误。
5. 旧配置文件不含 `acl` 键，解析/序列化均向后兼容。
