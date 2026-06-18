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

// -----------------------------------------
// sitelist.txt を読む（複数サイト用）
// -----------------------------------------
function loadSiteList() {
	const file = path.join(__dirname, "sitelist.txt");
	if (!fs.existsSync(file)) {
		console.error("❌ sitelist.txt がありません");
		process.exit(1);
	}
	return fs
		.readFileSync(file, "utf8")
		.split("\n")
		.map(l => l.trim())
		.filter(l => l && !l.startsWith("#"));
}

// -----------------------------------------
// 1サイト分をクロールして sitemap を出す関数
// -----------------------------------------
async function crawlOneSite(ROOT, browser) {
	console.log("\n🌐 Start:", ROOT);

	const domain = new URL(ROOT).hostname.replace(/\./g, "_");
	const OUTPUT_DIR = path.join(__dirname, "sitemaps");
	const OUTPUT = path.join(OUTPUT_DIR, `${domain}.json`);

	if (!fs.existsSync(OUTPUT_DIR)) {
		fs.mkdirSync(OUTPUT_DIR, { recursive: true });
	}

	const MAX_DETAIL = 10;
	let newsCount = 0;
	let blogCount = 0;

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
			// エラーでも URL だけ残したいなら重複を避けて追加しないでもOK
			if (!sitemap.includes(url)) {
				sitemap.push(url);
			}
		}
	}

	await page.close();

	fs.writeFileSync(OUTPUT, JSON.stringify(sitemap, null, 2));
	console.log(`📄 保存: ${OUTPUT}`);
}

// -----------------------------------------
// エントリーポイント
// -----------------------------------------
(async () => {
	const argUrl = process.argv[2];

	const browser = await puppeteer.launch({ headless: true });

	if (argUrl) {
		// 1サイトだけクロール
		await crawlOneSite(argUrl, browser);
	} else {
		// sitelist.txt に書かれている全サイトを順にクロール
		const sites = loadSiteList();
		for (const site of sites) {
			await crawlOneSite(site, browser);
		}
	}

	await browser.close();
	console.log("\n✅ すべて完了");
})();