# 大陆正式域名切换：laixue.online

## 当前约束

- 未来中国大陆正式域名：`laixue.online`；
- `laixue.work` 继续指向香港现网，不能作为北京服务器的上线入口；
- 北京服务器在 ICP 完成前只能作源站与测试环境，不得接管正式流量。

这份约束覆盖此前所有将 `laixue.work` 作为大陆正式域名的部署假设。

## 北京服务器的域名配置

北京机的 `/opt/laixue/app/.env.deploy` 在测试期设置：

```dotenv
LAIXUE_DOMAIN=bj.laixue.online
```

该子域名仅用于验证北京源站、HTTPS、登录和上传，不迁移现有用户流量。正式切换时才改为：

```dotenv
LAIXUE_DOMAIN=laixue.online
```

然后重新构建并发布一次。

## 切换前必须同时满足

1. `laixue.online` 完成与北京轻量服务器匹配的 ICP 备案；
2. `bj.laixue.online` 已验证北京服务的健康检查、登录、PDF、课程生成与上传；
3. Supabase Auth 的 Site URL 与 Redirect URLs 已加入 `https://laixue.online`、`https://www.laixue.online` 和测试子域名；
4. DNS 将 `laixue.online`、`www.laixue.online` 指向北京公网 IP，且 Caddy 已签发证书；
5. 保留 `laixue.work` → 香港的回退入口，直到新域名正式验收结束。

## 不需要变更的内容

- Supabase 项目与数据库地址；
- 现有用户数据；
- AI、PDF、语音等服务密钥；
- Git 仓库与自动发布链路。

域名改变的是访问入口和登录回调白名单，不是数据库迁移。
