# 食旅集 · DESIGN BY ZEN

海外菜单拍照 → 本地读字 / 云端翻译 → 分类点餐 → 购物清单点单卡。

## 本地开发

```bash
npm install
npm run dev
```

打开终端提示的地址（如 `http://localhost:5173`）。

## DeepSeek 配置

| 项 | 值 |
|----|-----|
| API Key | [platform.deepseek.com](https://platform.deepseek.com) 创建 |
| Base URL | `https://api.deepseek.com` |
| 模型 | `deepseek-v4-flash` 或 `deepseek-v4-pro` |

> DeepSeek 官方 API **不能直接看图**。本应用会：本地 OCR 读字 → DeepSeek 分类翻译。

**不要把 API Key 提交到公开仓库。** 手机可在设置页填写一次，保存在浏览器 localStorage。

手机快速写入（仅自己使用，勿转发链接）：

```
https://你的站点/?key=sk-你的密钥
```

打开后会自动写入本机并清除地址栏参数。

## 部署（手机可直接用）

### 推荐：Cloudflare Pages（含 API 代理，解决 CORS）

1. 代码推到 GitHub
2. [Cloudflare Pages](https://pages.cloudflare.com) → 连接仓库
3. 构建设置：
   - Build command: `npm run build`
   - Build output: `dist`
   - Root: `/`
   - Environment variable `BASE_PATH` = `/`（自定义域名或 `*.pages.dev` 用根路径）
4. 部署后使用 `functions/api/**` 自动代理 DeepSeek / xAI

### GitHub Pages（仅静态页）

启用仓库 Settings → Pages → Source: GitHub Actions。  
推送 `main` 后自动构建。

#### 自定义域名 `slj.zenslab.top`（Cloudflare / 腾讯云 DNS）

仓库已包含 `public/CNAME` → `slj.zenslab.top`，构建 `BASE_PATH=/`。

**1. DNS 解析（Cloudflare 控制台，DNS only 灰色云）**

| 主机记录 | 类型 | 记录值 |
|---------|------|--------|
| `slj` | **CNAME** | `zen920307-ai.github.io` |

> 不要加 `https://`；Proxy 必须 **DNS only**（灰色云）。

若 NS 在腾讯云 DNSPod，则：主机记录 `slj`，类型 CNAME，记录值 `zen920307-ai.github.io`。

**2. GitHub 仓库 → Settings → Pages**

- Custom domain 填：`slj.zenslab.top`
- DNS 通过后勾选 **Enforce HTTPS**

**3. 验证**

```bash
nslookup slj.zenslab.top 8.8.8.8
# 应显示 canonical name = zen920307-ai.github.io
```

访问：https://slj.zenslab.top  

> 纯 GitHub Pages **没有后端代理**，浏览器直连 DeepSeek 可能遇 CORS。  
> 手机要稳定识别，请用 **Cloudflare Pages** 或自建 Worker。

## 功能

- 拍照 / 相册多图
- DeepSeek 智能分类翻译（优先菜单原分类）
- 仅收录带价格的菜品
- 菜品配图（按菜名生成/严格匹配，宁缺毋滥）
- 购物清单点单卡（原价突出）
- 点单旅记

DESIGN BY ZEN
