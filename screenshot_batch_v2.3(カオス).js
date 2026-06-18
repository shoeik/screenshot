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
	const paths = u.pathname.split("/").filter(Boolean);
	// ルート（/）は特別扱い
	if (paths.length === 0) return "top";

	// /contact/ → contact
	// /service/web/seo/ → service_web_seo
	return paths.join("_");

}



// ============================================================
//  Utility: LazyLoad対策スクロール（300pxずつ）
// ============================================================
	async function scrollForLazyLoad(page, maxTime = 8000, step = 300) {
		await page.evaluate((maxTime, step) => {
			return new Promise(resolve => {
			const start = Date.now();

			const timer = setInterval(() => {
				window.scrollBy(0, step);

				if (Date.now() - start > maxTime) {
				clearInterval(timer);
				resolve();
				}
			}, 100);
			});
		}, maxTime, step);
	}

// ============================================================
//  Utility: 画像ロード最大5秒待ち
// ============================================================
	async function waitForImages(page, timeout = 5000) {
		await page.evaluate((timeout) => {
			const images = Array.from(document.images);

			return Promise.race([
			Promise.allSettled(
				images.map(img =>
				img.complete
					? Promise.resolve()
					: new Promise(resolve => {
						img.onload = img.onerror = resolve;
						setTimeout(resolve, timeout);
					})
				)
			),
			new Promise(resolve => setTimeout(resolve, timeout))
			]);
		}, timeout);
	}




// ---------------------------------------
// 6. メイン処理
// ---------------------------------------
(async () => {

	const browser = await puppeteer.launch({ headless: true });
	const pagePC = await browser.newPage();
	const pageSP = await browser.newPage();

	// ★ PC User-Agent & viewport
	await pagePC.setUserAgent(
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
		"AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
	);
	await pagePC.setViewport({ width: 1280, height: 900 });


	// ★ SP User-Agent & viewport
	await pageSP.setUserAgent(
		"Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) " +
		"AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 " +
		"Mobile/15E148 Safari/604.1"
	);
	await pageSP.setViewport({ width: 390, height: 844 });

	let count = 0;

	for (const url of urls) {
		count++;

		const slug = toSafeSlug(url);
		const saveDir = path.join("screenshots", domain, slug);

		const baseName = `${domain}_${slug}`;
		const pcPath = path.join(saveDir, `${baseName}_pc.webp`);
		const spPath = path.join(saveDir, `${baseName}_sp.webp`);




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


			//----------------------------------------------------
			// Syncity.co.jp 用：GSAP / ScrollTrigger 完全殺しパッチ
			//----------------------------------------------------
			await pagePC.evaluate(() => {
				// --- ScrollTrigger kill ---
				try {
					if (window.ScrollTrigger) {
						ScrollTrigger.getAll().forEach(t => t.kill());
					}
				} catch(e){}

				// --- GSAP timeline kill ---
				try {
					if (window.gsap) {
						gsap.globalTimeline.clear();
					}
				} catch(e){}

				// --- inline-style の opacity / transform / transition を削除 ---
				document.querySelectorAll("[style]").forEach(el => {
					el.style.opacity = "";
					el.style.transform = "";
					el.style.transition = "";
					el.style.animation = "";
				});

				// --- AOS / motion / *.inview 系を強制リセット ---
				const RESET = `
					opacity:1 !important;
					transform:none !important;
					animation:none !important;
					transition:none !important;
				`;
				document.querySelectorAll(
					"[data-aos], .js-animate, .animate, .motion, .fadein, .inview, .is-animated"
				).forEach(el => {
					el.style.cssText += RESET;
				});

				// --- data 属性削除（ScrollTrigger/AOS が参照するため）---
				document.querySelectorAll("*").forEach(el => {
					for (const key of Object.keys(el.dataset)) {
						delete el.dataset[key];
					}
				});

				// --- 最上部に戻す（scrollTrigger のフラグ解除用） ---
				window.scrollTo(0, 0);
			});


			
			// ★ LazyLoad 対策：スクロールして画像読み込ませる
			await scrollForLazyLoad(pagePC);

			// ★ 画像ロード待ち（最大5秒）
			await waitForImages(pagePC);


			await pagePC.screenshot({
				path: pcPath,
				type: "webp",
				quality: 80,
				fullPage: true
			});
		} catch (e) {
			console.log("   ❌ PCスクショ失敗:", e.message);
		}

		// -----------------------------------
		// SP キャプチャ
		// -----------------------------------
		try {
			await pageSP.goto(url, { waitUntil: "networkidle2", timeout: 30000 });

			await scrollForLazyLoad(pageSP);
			await waitForImages(pageSP);

			await pageSP.screenshot({
				path: spPath,
				type: "webp",
				quality: 80,
				fullPage: true
			});
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