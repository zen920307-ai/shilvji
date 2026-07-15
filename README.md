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

#### 自定义域名 `zenslab.top`（腾讯云 DNS）

仓库已包含 `public/CNAME`，构建时 `BASE_PATH=/`（根路径）。

**1. 腾讯云控制台 → 域名解析 DNSPod → `zenslab.top`**

| 主机记录 | 类型 | 记录值 | 说明 |
|---------|------|--------|------|
| `@` | **A** | `185.199.108.153` | 根域名（共 4 条 A） |
| `@` | **A** | `185.199.109.153` | |
| `@` | **A** | `185.199.110.153` | |
| `@` | **A** | `185.199.111.153` | |
| `www` | **CNAME** | `zen920307-ai.github.io` | 可选 www 跳转 |

TTL 可先设 600 秒。

**2. GitHub 仓库 → Settings → Pages**

- Custom domain 填：`zenslab.top`
- 勾选 **Enforce HTTPS**（DNS 生效后才可勾选，约几分钟～几小时）
- 若提示 DNS check failed，等解析生效后点 **Recheck**

**3. 验证**

```bash
# 应能解析到上述 GitHub IP
nslookup zenslab.top
```

访问：https://zenslab.top  

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
