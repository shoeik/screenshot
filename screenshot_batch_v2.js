const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

/**
 * ============================================================
 *   screenshot_batch.js（完全版）
 * ------------------------------------------------------------
 * ・sitemap.json に含まれる URL 全てをスクショする
 * ・PC / SP 両方のフルページ撮影
 * ・サイト別に screenshots_db/{domain}.json を保存
 * ・screenshots/{domain}/{slug}/pc.jpg などに保存
 * ・URL をキーにするため衝突なし
 * ・既存スクショがあればスキップ
 * ============================================================
 */

// ---------------------------------------
// 1. 引数チェック
// ---------------------------------------
const SITEMAP_FILE = process.argv[2];
if (!SITEMAP_FILE) {
	console.error("❌ sitemap.json を指定してください\n例: node screenshot_batch.js ./sitemaps/example_com.json");
	process.exit(1);
}

// ---------------------------------------
// 2. URLリストを読み込む
// ---------------------------------------
const urls = JSON.parse(fs.readFileSync(SITEMAP_FILE, "utf-8"));
if (!Array.isArray(urls)) {
	console.error("❌ sitemap.json は URL の配列である必要があります");
	process.exit(1);
}

console.log(`🌐 読み込み完了: ${urls.length} URL`);

// ---------------------------------------
// 3. ドメイン名を抽出して DB の保存先決定
// ---------------------------------------
const firstURL = new URL(urls[0]);
const domain = firstURL.hostname.replace(/\./g, "_");
const DB_FILE = `./screenshots_db/${domain}.json`;

// フォルダがなければ作る
fs.mkdirSync("./screenshots_db", { recursive: true });

// ---------------------------------------
// 4. 既存DBをロード（差分撮影に対応）
// ---------------------------------------
let db = {};
if (fs.existsSync(DB_FILE)) {
	db = JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
}

console.log(`🗂 既存DB: ${Object.keys(db).length} 件`);

// ---------------------------------------
// 5. URL から安全な slug を作る
// ---------------------------------------
function toSafeSlug(url) {
	const u = new URL(url);
	let s = u.pathname.replace(/\//g, "_");
	if (s === "_") s = "_root";
	return s;
}

// ---------------------------------------
// 6. メイン処理
// ---------------------------------------
(async () => {

	const browser = await puppeteer.launch({ headless: true });
	const pagePC = await browser.newPage();
	const pageSP = await browser.newPage();

	// PC
	await pagePC.setViewport({ width: 1280, height: 900 });

	// SP
	await pageSP.setViewport({ width: 375, height: 900 });

	let count = 0;

	for (const url of urls) {
		count++;

		const slug = toSafeSlug(url);
		const saveDir = path.join("screenshots", domain, slug);

		const pcPath = path.join(saveDir, "pc.jpg");
		const spPath = path.join(saveDir, "sp.jpg");

		// 既に両方存在 → スキップ
		if (fs.existsSync(pcPath) && fs.existsSync(spPath)) {
			console.log(`⏭ (${count}/${urls.length}) スキップ: ${url}`);
			continue;
		}

		console.log(`📸 (${count}/${urls.length}) 撮影中: ${url}`);

		// フォルダ作成
		fs.mkdirSync(saveDir, { recursive: true });

		// -----------------------------------
		// PC キャプチャ
		// -----------------------------------
		try {
			await pagePC.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
			await pagePC.screenshot({ path: pcPath, fullPage: true });
		} catch (e) {
			console.log("   ❌ PCスクショ失敗:", e.message);
		}

		// -----------------------------------
		// SP キャプチャ
		// -----------------------------------
		try {
			await pageSP.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
			await pageSP.screenshot({ path: spPath, fullPage: true });
		} catch (e) {
			console.log("   ❌ SPスクショ失敗:", e.message);
		}

		// -----------------------------------
		// DB 登録（URL をキーにするため衝突ゼロ）
		// -----------------------------------
		db[url] = {
			url,
			domain,
			slug,
			path: {
				pc: pcPath,
				sp: spPath
			},
			tags: db[url]?.tags || [] // 既存タグ維持
		};

	}

	await browser.close();

	// -----------------------------------
	// DB 保存
	// -----------------------------------
	fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));

	console.log("\n💾 保存:", DB_FILE);
	console.log("✅ 完了！");
})();