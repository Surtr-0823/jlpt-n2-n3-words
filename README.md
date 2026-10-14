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
- 例句中文翻译由机器翻译生成（脚本 `work/translate.mjs`）。原 PDF 没有句子翻译，
  所以这部分是补的；翻译前会把假名形式的目标词替换成汉字形式以消歧
  （否则「ふくし」会被翻成「福岛」这类错误）。属于辅助理解，仅供参考。
- 重建命令：`python work/build_dataset.py`

## 功能

- 三种题型：日→中、中→日、例句填空，可单一或混合轮流出现。
  例句填空可以直接把答案打出来再点「对答案」判分（汉字写法与假名写法都算对），
  不想打字时点「显示答案」也一样能翻面自评。
- **课前预习**：每天第一次学习前，先把今日新词连同读音、释义、例句和句子翻译过一遍。
- **完成期限计划**：设定目标日期（默认 2026-12-06），自动按「剩余词数 ÷ 剩余天数」
  算出每天要学多少个新词，并按最近 7 天的实际速度预测完成日期。
- 例句填空会给出整句中文翻译作为提示，答完再显示完整句子。
- 间隔重复排程、词表浏览与搜索、进度统计（14 天图可点柱子看当天数值）、导出/导入进度。
- PWA：可添加到 iOS 主屏幕，Service Worker 离线缓存。

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

> **改词库后记得改版本号**：`app.js` 里的 `DATA_V` 要 +1。
> 手机上的 Service Worker 会按「缓存优先」提供 `data/words.json`，
> 版本号一变，地址就变了，才会去网上重新拉。忘了改也不会永久卡住 ——
> Service Worker 现在对 `data/` 用的是「先用缓存、后台刷新」，
> 下一次打开就会自动更新。

## 部署到 GitHub Pages

```bash
git remote add origin https://github.com/<用户名>/<仓库名>.git
git push -u origin main
```

然后在仓库 Settings → Pages 里选择 `Deploy from a branch` → `main` / `(root)`。
几分钟后访问 `https://<用户名>.github.io/<仓库名>/`。
