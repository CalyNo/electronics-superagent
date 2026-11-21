# 配置示例

本目录提供四份可直接改用的配置样例。所有 `<...>` 与 `xxxxxxxx` 均为占位符，必须替换为真实值。

| 文件 | 作用 | 加载方式 |
| --- | --- | --- |
| `profile.cordis.patch.yml` | 插件装配与机器级配置 | 复制到 `~/.dsh/profiles/electronics/cordis.patch.yml` |
| `feishu-source.example.yml` | 飞书来源配置 | 通过管理 API 写入 `source:feishu` 配置块 |
| `policy.example.yml` | 角色、准入与规则 | 通过管理 API 写入 `policy` 配置块 |
| `ai-keys.example.yml` | 模型密钥池、路由与预算 | 复制到 `/etc/electronics-superagent/ai-keys.yml`，由本地模型网关读取 |

> `ai-keys.example.yml` **只存环境变量名，不存密钥值**。它与前三份文件的加载路径不同：前三份经管理 API 进入业务配置，此份由网关独立进程加载，改完热生效，不影响执行器。设计说明见 [../docs/08-AI密钥与模型分配.md](../docs/08-AI密钥与模型分配.md)。

## 1. 使用顺序

```
0. 先在密钥管理里创建 key，写入环境变量；填好 ai-keys.yml 并启动网关
1. 复制 profile.cordis.patch.yml 到 profile 目录
2. 替换 stateDir、端口、CLI 路径
3. 启动服务，确认 setup 通过
4. 用管理 API 写入飞书来源配置
5. 用管理 API 写入策略配置
6. 在面板确认 Source 为 ready
7. 用白名单账号 @ 机器人 发起一次测试
```

## 2. 管理 API 调用

```sh
API=http://127.0.0.1:3082/orchestrator/api

# 读取当前版本
curl -s -H 'x-orchestrator-request: 1' $API/settings | jq '.sources'

# 写入飞书来源
rev=$(curl -s -H 'x-orchestrator-request: 1' $API/settings \
  | jq '.sources[] | select(.id=="feishu") | .revision')
curl -X PUT -H 'x-orchestrator-request: 1' -H 'content-type: application/json' \
  $API/settings/source:feishu \
  -d "{\"value\": $(cat feishu-source.example.yml | yq -o=json), \"revision\": $rev}"

# 写入策略
prev=$(curl -s -H 'x-orchestrator-request: 1' $API/settings | jq '.blocks.policy.revision')
curl -X PUT -H 'x-orchestrator-request: 1' -H 'content-type: application/json' \
  $API/settings/policy \
  -d "{\"value\": $(cat policy.example.yml | yq -o=json), \"revision\": $prev}"
```

## 3. 校验

| 检查 | 命令 |
| --- | --- |
| YAML 语法 | `yq eval '.' <file>` |
| 必填字段 | 见各文件注释 |
| 账号可用 | `gh-agent api user --jq .login`、`lark-electronics auth whoami` |
| Source 状态 | `GET /orchestrator/api/sources` |
| 策略生效 | `GET /orchestrator/api/settings` 中的 `blocks.policy.value` |

## 4. 安全要求

- 四份文件均**不得**包含明文密钥；
- `appSecret` 通过环境变量或独立配置目录提供；
- 模型密钥只经环境变量名引用，真实值放在 Vault / KMS / `keys.d/`（`0600`）；
- 配置文件不进入 Git 仓库，或进入时先脱敏；
- 修改后必须记录变更人与原因。

## 5. 最小可用配置

如果只想验证链路，最少需要：

```yaml
# profile: stateDir + port
# source: appId + cli + 一个 chatId
# policy: 一个 allowed 成员 + acceptMode: observe
```

其余全部留默认值。
