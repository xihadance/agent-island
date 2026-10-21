# Cute Island 产品宣传页

中文宣传页，以了解功能、查看 GitHub 源码为主要入口。复用桌面应用的真实灵动岛组件，演示数据与本机会话隔离；审批演示只显示提醒，不连接或批准真实请求。

## 本地预览

在仓库根目录运行：

```bash
npm run dev:site
```

访问 http://127.0.0.1:5175/ 。需要 Node.js 22.12 或更高版本，并先安装项目依赖。

## 构建与发布

```bash
npm run typecheck
npm run build:site
npm run preview:site
```

产物位于 `dist/site/`，可部署到静态网站托管平台。资源使用相对路径，可放在域名根目录或子目录；不需要 Electron、后端接口或渠道凭据。

## 内容与资源

- `Website.tsx`：中文文案、导航、主题切换、功能说明、远程接管、常见问题与 GitHub 入口。
- `IslandDemo.tsx`：多任务、审批提醒和空闲收纳演示，支持点击及方向键切换场景。
- `site.css`：独立网站样式，支持浅色、深色、手机布局及减少动态效果偏好。
- `../../build/icon.png`：仓库已有品牌图标。
- `../../media/intro-poster.png`、`../../media/cute-island-intro.mp4`：仓库已有介绍视频与封面。

主题偏好保存在浏览器的 `cute-island-site-theme` 键中；未选择时跟随系统。页面链接指向 `https://github.com/xihadance/agent-island`，更换仓库时修改 `Website.tsx` 中的 `GITHUB` 常量。
