# 样品管理系统

旧版 `leacy` 的 MySQL + SSO 重构版本。运行环境为 Node.js 18+ 和 MySQL 8.0+。

## 初始化

1. 复制 `.env.example` 为 `.env`，使用专用数据库账号填写配置；不要提交 `.env`。
2. 在 shell 中导出 `.env` 变量后执行：

   ```bash
   npm install
   npm run migrate
   npm test
   npm start
   ```

`npm run migrate` 会创建数据库和表，导入 `../leacy/data/samples.json` 中的样品、负责人及图片，不导入旧用户。迁移可重复执行。

生产部署示例位于 `deploy/`：内测应用监听 `192.168.22.191:8081`，由 `private.qiyinbz.com:41287` HTTPS 服务反向代理 `/samples/`；转正式服时替换该上游地址。安装 systemd 服务前先创建无登录权限的 `sample-system` 用户，并赋予 `uploads/` 写权限。

## SSO

未登录页面跳转到 `SSO_LOGIN_URL?return_to=当前地址`。回跳的 `token` 由后端调用 `SSO_USERINFO_URL` 验证，并换成 HttpOnly 本地会话。

权限：`sample:view` 查询、`sample:edit` 业务操作、`sample:admin` 管理；`*:*:*` 拥有全部权限。部署地址必须加入统一登录系统的 `return_to` 白名单。

创建样品时，创建人姓名和手机号由 SSO `getInfoV2` 返回的 `nickName`、`phonenumber` 自动写入，客户端提交值不会被采用。

## 数据与备份

- 业务数据位于 MySQL，图片位于 `UPLOAD_DIR`，必须同时备份。
- 建议每日使用 `mysqldump --single-transaction` 备份数据库，并对图片目录做增量归档。
- 恢复时先恢复数据库，再恢复同一时间点的图片目录。
