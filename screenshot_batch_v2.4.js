const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

/**
 * ============================================================
 *   screenshot_batch.js（ScrollTrigger/AOS 完全対応版）
 * ------------------------------------------------------------
 * ・ScrollTrigger / GSAP / AOS / inview を完全無効化
 * ・inline-style の opacity / transform / transition / animation を削除
 * ・全画像ロード待ち
 * ・LazyLoad スクロール
 * ・PC/SP 両方撮影
 * ・screenshots_db/{domain}.json へ DB 保存
 * ・screenshots/{domain}/{slug}/{domain_slug_pc.webp}
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
// 2. URLリスト読み込み
// ---------------------------------------
const urls = JSON.parse(fs.readFileSync(SITEMAP_FILE, "utf-8"));
if (!Array.isArray(urls)) {
	console.error("❌ sitemap.json は URL 配列である必要があります");
	process.exit(1);
}
console.log(`🌐 読み込み完了: ${urls.length} URL`);

// ---------------------------------------
// 3. ドメイン名
// ---------------------------------------
const firstURL = new URL(urls[0]);
const domain = firstURL.hostname.replace(/\./g, "_");
const DB_FILE = `./screenshots_db/${domain}.json`;
fs.mkdirSync("./screenshots_db", { recursive: true });

// ---------------------------------------
// 4. DB 読み込み
// ---------------------------------------
let db = fs.existsSync(DB_FILE)
	? JSON.parse(fs.readFileSync(DB_FILE, "utf-8"))
	: {};

console.log(`🗂 既存DB: ${Object.keys(db).length} 件`);

// ---------------------------------------
// 5. slug 生成
// ---------------------------------------
function toSafeSlug(url) {
	const u = new URL(url);
	const paths = u.pathname.split("/").filter(Boolean);
	return paths.length === 0 ? "top" : paths.join("_");
}

// ============================================================
//  Utility 1: LazyLoad スクロール
// ============================================================
async function scrollForLazyLoad(page, maxMs = 8000) {
	await page.evaluate(async (maxMs) => {
		const vh = window.innerHeight;
		const step = vh * 0.7;
		const start = Date.now();

		await new Promise(resolve => {
			const timer = setInterval(() => {
				window.scrollBy(0, step);

				if (Date.now() - start > maxMs ||
					window.scrollY + vh >= document.body.scrollHeight) {
					clearInterval(timer);
					resolve();
				}
			}, 150);
		});
	}, maxMs);
}

// ============================================================
//  Utility 2: 画像ロード待ち
// ============================================================
async function waitForImages(page, timeout = 8000) {
	await page.evaluate((timeout) => {
		return new Promise(resolve => {
			let waited = 0;
			const timer = setInterval(() => {
				const done = [...document.images].every(img => img.complete);
				if (done || waited > timeout) {
					clearInterval(timer);
					resolve();
				}
				waited += 200;
			}, 200);
		});
	}, timeout);
}

// ============================================================
//  Utility 3: ScrollTrigger / GSAP / AOS 完全殺し
// ============================================================
async function disableAnimations(page) {
	await page.evaluate(() => {

		// =============== ScrollTrigger kill ===============
		try {
			if (window.ScrollTrigger) {
				ScrollTrigger.getAll().forEach(t => t.kill());
			}
		} catch(e){}

		// =============== GSAP timeline kill ===============
		try {
			if (window.gsap) {
				gsap.globalTimeline.clear();
			}
		} catch(e){}

		// =============== inline-style の opacity / transform 削除 ===============
		document.querySelectorAll("[style]").forEach(el => {
			el.style.opacity = "";
			el.style.transform = "";
			el.style.transition = "";
			el.style.animation = "";
		});

		// =============== AOS / inview / motion 系 ===============
		const FIX_STYLE = `
			opacity:1 !important;
			transform:none !important;
			animation:none !important;
			transition:none !important;
		`;

		document.querySelectorAll(
			"[data-aos], .js-animate, .animate, .motion, .fadein, .inview, .is-animated"
		).forEach(el => {
			el.style.cssText += FIX_STYLE;
		});

		// =============== data 属性削除 (AOS/ScrollTrigger 対策) ===============
		document.querySelectorAll("*").forEach(el => {
			for (const key of Object.keys(el.dataset)) {
				delete el.dataset[key];
			}
		});

		window.scrollTo(0, 0);
	});
}

// ---------------------------------------
// 6. メイン処理
// ---------------------------------------
(async () => {
	const browser = await puppeteer.launch({ headless: true });

	const pagePC = await browser.newPage();
	const pageSP = await browser.newPage();

	// PC
	await pagePC.setUserAgent(
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
	);
	await pagePC.setViewport({ width: 1280, height: 900 });

	// SP
	await pageSP.setUserAgent(
		"Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile Safari/604.1"
	);
	await pageSP.setViewport({ width: 390, height: 844 });

	let count = 0;

	for (const url of urls) {
		count++;

		const slug = toSafeSlug(url);
		const saveDir = path.join("screenshots", domain, slug);

		const fileBase = `${domain}_${slug}`;
		const pcPath = path.join(saveDir, `${fileBase}_pc.webp`);
		const spPath = path.join(saveDir, `${fileBase}_sp.webp`);

		// 既に撮影済み
		if (fs.existsSync(pcPath) && fs.existsSync(spPath)) {
			console.log(`⏭ (${count}/${urls.length}) スキップ: ${url}`);
			continue;
		}

		console.log(`📸 (${count}/${urls.length}) 撮影中: ${url}`);
		fs.mkdirSync(saveDir, { recursive: true });

		// -------------------------------------------------------
		// PC
		// -------------------------------------------------------
		try {
			await pagePC.goto(url, { waitUntil: "networkidle2", timeout: 35000 });

			await disableAnimations(pagePC);
			await scrollForLazyLoad(pagePC);
			await waitForImages(pagePC);

			await pagePC.screenshot({ path: pcPath, type: "webp", quality: 80, fullPage: true });
		} catch (e) {
			console.log("   ❌ PC撮影失敗:", e.message);
		}

		// -------------------------------------------------------
		// SP
		// -------------------------------------------------------
		try {
			await pageSP.goto(url, { waitUntil: "networkidle2", timeout: 35000 });

			await disableAnimations(pageSP);
			await scrollForLazyLoad(pageSP);
			await waitForImages(pageSP);

			await pageSP.screenshot({ path: spPath, type: "webp", quality: 80, fullPage: true });
		} catch (e) {
			console.log("   ❌ SP撮影失敗:", e.message);
		}

		// DB 保存
		db[url] = {
			url,
			domain,
			slug,
			path: { pc: pcPath, sp: spPath },
			tags: db[url]?.tags || []
		};
	}

	await browser.close();

	fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));

	console.log("\n💾 保存:", DB_FILE);
	console.log("✅ 完了！");
})();