const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

// =========================================
// ★ 除外対象の拡張子
// =========================================
const EXCLUDE_EXT = [
	".pdf", ".zip", ".rar", ".7z",
	".doc", ".docx", ".xls", ".xlsx",
	".ppt", ".pptx", ".csv",
	".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg",
	".mp4", ".mp3", ".mov", ".avi"
];

function isExcludedFile(url) {
	try {
		const pathname = new URL(url).pathname.toLowerCase();
		return EXCLUDE_EXT.some(ext => pathname.endsWith(ext));
	} catch {
		return true;
	}
}

// =========================================
// CLI：node crawl_sitemap.js https://example.com/
// =========================================
const ROOT = process.argv[2] || "https://example.com/";


// どのサイトかわかるようにドメイン名を抽出する
const domain = new URL(ROOT).hostname.replace(/\./g, "_");
// 保存先をドメイン別にする
const OUTPUT = `./sitemaps/${domain}.json`;

// 保存フォルダが無ければ作る
if (!fs.existsSync("./sitemaps")) {
	fs.mkdirSync("./sitemaps");
}

const MAX_DETAIL = 10;

let newsCount = 0;
let blogCount = 0;

console.log("🌐 Start:", ROOT);

// =========================================
// main
// =========================================
(async () => {
	const browser = await puppeteer.launch({ headless: true });
	const page = await browser.newPage();

	const visited = new Set();
	const queue = [ROOT];
	const sitemap = [];

	while (queue.length > 0) {
		const url = queue.shift();
		if (!url) continue;
		if (visited.has(url)) continue;
		visited.add(url);

		console.log("▶", url);

		// 除外ファイル
		if (isExcludedFile(url)) {
			console.log("   ❌ 除外:", url);
			continue;
		}

		try {
			const res = await page.goto(url, {
				waitUntil: "domcontentloaded",
				timeout: 30000
			});

			console.log("   status:", res.status());

			// ★ URLだけを保存
			sitemap.push(url);

			// HTML以外は終了
			const ctype = res.headers()["content-type"] || "";
			if (!ctype.includes("text/html")) {
				console.log("   ❌ HTML以外 → スキップ");
				continue;
			}

			// ページ内リンク取得
			const links = await page.$$eval("a", as =>
				as.map(a => a.href).filter(Boolean)
			);

			for (let link of links) {
				try {
					const abs = new URL(link, url).href;

					if (abs.includes("#")) continue;
					if (!abs.startsWith(ROOT)) continue;
					if (isExcludedFile(abs)) continue;

					const p = new URL(abs).pathname.toLowerCase();

					// news/blog の詳細ページ（ゆるゆる判定）
					if (p.includes("/news/")) {
						if (newsCount >= MAX_DETAIL) continue;
						newsCount++;
					}
					if (p.includes("/blog/")) {
						if (blogCount >= MAX_DETAIL) continue;
						blogCount++;
					}

					if (!visited.has(abs) && !queue.includes(abs)) {
						queue.push(abs);
					}

				} catch (e) {}
			}

		} catch (err) {
			console.log("   ❌ ERROR:", err.message);

			// ★ ここもURLだけ保存
			sitemap.push(url);
		}
	}

	await browser.close();

	fs.writeFileSync(OUTPUT, JSON.stringify(sitemap, null, 2));
	console.log("\n📄 sitemap.json を保存しました！");
})();