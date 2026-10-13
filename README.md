# N2 / N3 考点单词（背词站）

纯静态站点：无构建步骤、无第三方依赖、无后端。可直接放到 GitHub Pages / Vercel / Netlify
或任意静态托管。

## 词库

| 词库 | 级别 | 词条 |
|---|---|---|
| N2 考点单词 2010-2024 | N2 | 676 |
| N2 反复考察的单词 | N2 | 120 |
| N3 考点单词 2010-2025 | N3 | 736 |
| N3 高频重点词汇 | N3 | 325 |

合并去重后 **1410 条**（N2 711 / N3 699），**2133 条例句**。

- 词、中文释义、例句取自用户提供的 PDF 词表。
- 读音经 **JMdict** 与 **OpenJLPT** 双向校验，修正了原表 20+ 处录入错误
  （如 葉 くすり→は、熱心 あつい→ねっしん、無口 むぐち→むくち）。
- 例句中目标词的位置来自 PDF 的红色高亮，用于卡片上的挖空与标注。
- 重建命令：`python work/build_dataset.py`

## 结构

```
site/
  index.html          单页应用
  app.css             样式
  app.js              逻辑（学习流程 + 间隔重复 + 进度存储）
  data/
    words.json        词库（由 work/build_dataset.py 生成）
    manifest.json     词库元信息
  sw.js               Service Worker（离线缓存）
  manifest.webmanifest  PWA 配置（可添加到主屏幕）
```

## 本地预览

```powershell
python -m http.server 8787 --directory site
```

然后浏览器打开 http://localhost:8787

> iOS 上要获得「添加到主屏幕 + 离线可用」，站点必须走 HTTPS
> （Service Worker 不接受普通 http，localhost 除外）。
> 用 GitHub Pages 或 Netlify 部署即自带 HTTPS。

## 进度存储

- 本地：`localStorage`（键 `jlpt.progress.v1`），手机离线也能背。
- 换设备：设置页「导出进度文件」→ 在另一台设备「导入」，导入是**求并集**，不覆盖。
- 云端同步（待接入）：Supabase，见下方说明。

进度结构是**追加式复习日志**（每条 = 词 + 评分 + 时间戳），
卡片状态由日志实时重算。因此多设备合并时只需求并集，
不会出现「手机上背的记录被平板覆盖」这类问题。接入云端同步时不需要改动存储格式。

## 部署到 GitHub Pages

```bash
git remote add origin https://github.com/<用户名>/<仓库名>.git
git push -u origin main
```

然后在仓库 Settings → Pages 里选择 `Deploy from a branch` → `main` / `(root)`。
几分钟后访问 `https://<用户名>.github.io/<仓库名>/`。
