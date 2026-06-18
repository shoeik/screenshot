const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

/**
 * ------------------------------------------------------
 *  PC/SP 両方を自動スクショするバッチスクリプトの完全版
 * ------------------------------------------------------
 *  使い方：
 *  node screenshot_batch.js sitemap.json
 *
 *  sitemap.json： ["https://example.com/", "/about/", ...] の単純配列
 *
 *  出力：
 *   /screenshots/{domain}/{slug}/pc.jpg
 *   /screenshots/{domain}/{slug}/sp.jpg
 *
 *   screenshots.json には DB が保存される
 * ------------------------------------------------------
 */

// =======================================
// 引数チェック
// =======================================
const SITEMAP_FILE = process.argv[2];
if (!SITEMAP_FILE) {
	console.error("❌ sitemap.json を指定してください\n例: node screenshot_batch.js sitemap.json");
	process.exit(1);
}

// =======================================
// 読み込み
// =======================================
const urls = JSON.parse(fs.readFileSync(SITEMAP_FILE, "utf-8"));
console.log("🌐 URL 数:", urls.length);

let db = {};
const DB_FILE = "./screenshots.json";

// 既存DBがあれば読み込む（差分処理できる）
if (fs.existsSync(DB_FILE)) {
	db = JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
}



// =======================================
// 保存用の安全な slug を作る
// =======================================
function toSafeSlug(url) {
	let u = new URL(url);
	let slug = u.pathname.replace(/\//g, "_");
	if (slug === "_") slug = "_root";
	return slug;
}

// =======================================
// メイン処理
// =======================================
(async () => {
	const browser = await puppeteer.launch({ headless: true });

	const pagePC = await browser.newPage();
	const pageSP = await browser.newPage();

	// PC viewport
	await pagePC.setViewport({ width: 1280, height: 800 });

	// SP viewport
	await pageSP.setViewport({ width: 375, height: 800 });

	let count = 0;

	for (const url of urls) {
		count++;
		const u = new URL(url);
		const domain = u.hostname;
		const slug = toSafeSlug(url);

		// 保存先フォルダ
		const saveDir = path.join("screenshots", domain, slug);

		// すでにスクショ済みならスキップ
		const pcPath = path.join(saveDir, "pc.jpg");
		const spPath = path.join(saveDir, "sp.jpg");

		if (fs.existsSync(pcPath) && fs.existsSync(spPath)) {
			console.log(`⏭ (${count}/${urls.length}) スキップ: ${url}`);
			continue;
		}

		console.log(`📸 (${count}/${urls.length}) 撮影中: ${url}`);

		// フォルダ作成
		fs.mkdirSync(saveDir, { recursive: true });

		// -------------------------------
		// PC スクショ
		// -------------------------------
		try {
			await pagePC.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
			await pagePC.screenshot({ path: pcPath, fullPage: true });
		} catch (e) {
			console.log("   ❌ PCスクショ失敗:", e.message);
		}

		// -------------------------------
		// SP スクショ
		// -------------------------------
		try {
			await pageSP.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
			await pageSP.screenshot({ path: spPath, fullPage: true });
		} catch (e) {
			console.log("   ❌ SPスクショ失敗:", e.message);
		}

		// -------------------------------
		// DBに登録
		// -------------------------------
		db[`${domain}${slug}`] = {
			url,
			domain,
			slug,
			path: {
				pc: pcPath,
				sp: spPath
			},
			tags: db[`${domain}${slug}`]?.tags || [] // 既存タグ維持
		};

	}

	await browser.close();

	// DB 保存
	fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
	console.log("\n💾 screenshots.json を保存しました！");
	console.log("✅ 完了！");
})();
