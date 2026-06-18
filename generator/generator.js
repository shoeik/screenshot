const fs = require("fs");
const path = require("path");
const { walkDir, guessByMap } = require("./utils");
const { industryMap, categoryMap, siteTypeMap } = require("./maps");

const SCREENSHOT_DIR = path.join(__dirname, "../screenshots");
const OUTPUT = path.join(__dirname, "../screenshots.json");

(async function generate() {
	console.log("🔍 スクショ解析中...");

	const files = walkDir(SCREENSHOT_DIR);
	const results = [];

	for (const file of files) {
		const rel = path.relative(SCREENSHOT_DIR, file).replace(/\\/g, "/");

		// site = 1階層目
		const [site, ...rest] = rel.split("/");
		const pagePath = rest.join("/");

		// URL推定
		const pathWithoutExt = pagePath.replace(".webp", "");
		const url = `https://${site}/${pathWithoutExt}`;

		// ファイル情報
		const stat = fs.statSync(file);
		const date = stat.mtime.toISOString().split("T")[0];

		// 推定用文字列
		const detectString = `${rel} ${url}`.toLowerCase();

		const industry = guessByMap(detectString, industryMap) || "その他";
		const category = guessByMap(detectString, categoryMap) || "other";
		const siteType = guessByMap(detectString, siteTypeMap) || "その他";

		const title = pathWithoutExt.split("/").slice(-1)[0] || "No Title";

    // JSONオブジェクト
    results.push({
		file: `./screenshots/${rel}`,
		site,
		url,
		title,
		industry,
		category,
		siteType,
		date,
		tags: []
		});
	}

	fs.writeFileSync(OUTPUT, JSON.stringify(results, null, 2), "utf-8");

	console.log("🎉 完了！ → screenshots.json を更新しました");
})();
