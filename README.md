# xLikes

那些曾经一闪而过但很有价值的内容，不应该只躺在 X 的点赞列表里。
xLikes 会把你点赞的推文同步到本地，变成你的个人知识库。

本项目使用 Node + Web 的运行模式，兼容 [JSBox](https://apps.apple.com/app/id1312014438) 运行。

## 它能做什么

- 同步你自己的 X 点赞列表到本地
- 按 X 风格浏览推文
- 搜索正文、作者、备注和标签
- 随机查看，重新发现以前点过赞的好东西
- 给推文打分、添加标签、写备注
- 归档不喜欢的内容，让主列表保持清爽

## 安装

[JSBox 一键安装](https://xteko.com/redir?name=xLikes&url=https%3A%2F%2Fgithub.com%2FGandum2077%2FxLikes%2Freleases%2Fdownload%2F1.0.0%2FxLikes.box)

> 需要 JSBox 版本 >= 2.30.1，且购买了 Node.js 运行时功能

### 在 Node.js 上运行

克隆源代码，进入目录并依次执行命令：

```
npm i
npm start
```

默认运行在`http://127.0.0.1:3000`，在`.env`文件中可以设置`HOST`和`PORT`

### 或者——重新编写

本项目由 Vibe Coding 生成，你也可以让 AI Agent 重新编写：
```
严格遵守 [AGENTS.md](AGENTS.md) ，完成 [TARGET.md](TARGET.md) 中的任务。
```

## 开始使用

首次使用时，应用会引导你完成 X 开发者页面上的准备工作，并填写 OAuth 2.0 Keys。

你需要准备：

- 一个可用的 X 账号
- X Developer Console 中创建好的 Project 和 App
- 已开启的 OAuth 2.0 用户授权
- 至少包含 `tweet.read`、`users.read`、`like.read` 的权限
- 如果希望长期使用自动刷新 Token，授权时还需要包含 `offline.access`

填写凭据后，点击保存并测试。应用会自动识别当前授权用户，不需要手动填写 User ID。

### 同步方式

应用提供两种同步方式：

- 增量同步：每次只读取少量新点赞，遇到本地已有内容就停止，尽量节省 X API 调用成本。
- 完全同步：适合第一次建库或需要重新整理全部点赞时使用。由于可能消耗较多额度，开始前会有确认提示。

同步时只保存推文信息。图片和视频会在你浏览到对应推文时再下载。

### 删除或失效的推文会怎样？

如果某条推文已经同步到本地，之后在 X 上删除或变得不可访问，应用不会主动从本地删除它。如果你不想在列表中看到某条推文，可以选择归档。

### 日志系统

在`.env`文件可以控制日志系统的开关
```
LOG_ENABLED=true
```