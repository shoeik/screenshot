const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

/**
 * ============================================================
 * screenshot_batch.js（最終スキーマ対応版）
 * ============================================================
 */

const TOP_INITIAL_WAIT = 3000;
const SCROLL_STEP = 300;
const SCROLL_INTERVAL = 120;
const LAZYLOAD_MAX_TIME = 8000;
const IMAGE_WAIT_TIMEOUT = 5000;
const PAGE_LOAD_TIMEOUT = 30000;
const PAGE_LOAD_FALLBACK_TIMEOUT = 15000;

const SITEMAP_FILE = process.argv[2];
if (!SITEMAP_FILE) {
	// ターミナル
	// node screenshot_batch.js ./sitemaps/mmslaw_jp.json
	console.error("❌ sitemap.json を指定してください");
	process.exit(1);
}

const urls = JSON.parse(fs.readFileSync(SITEMAP_FILE, "utf-8"));
if (!Array.isArray(urls) || urls.length === 0) {
	console.error("❌ sitemap.json は1件以上の URL 配列である必要があります");
	process.exit(1);
}

const firstURL = new URL(urls[0]);
const domain = firstURL.hostname.replace(/\./g, "_");
const DB_FILE = `./screenshots_db/${domain}.json`;

fs.mkdirSync("./screenshots_db", { recursive: true });

let db = {};
if (fs.existsSync(DB_FILE)) {
	db = JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
}

// ---------------------------------------
// Utility
// ---------------------------------------
function toSafeSlug(url) {
	const urlObj = new URL(url);
	const paths = urlObj.pathname.split("/").filter(Boolean);
	return paths.length === 0 ? "top" : paths.join("_");
}

function wait(milliseconds) {
	return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function isTopPage({ slug, pathname, depth }) {
	return slug === "top" || pathname === "/" || depth === 0;
}

async function hasUsableDom(page) {
	try {
		return await page.evaluate(() => {
			const body = document.body;
			if (!body || body.childElementCount === 0) {
				return false;
			}

			const hasText = (body.innerText || "").trim().length > 20;
			const hasVisualContent = Boolean(
				body.querySelector(
					"main, section, article, header, footer, h1, img, picture, video, canvas, svg"
				)
			);

			return hasText || hasVisualContent;
		});
	} catch {
		return false;
	}
}

async function gotoWithFallback(page, url) {
	try {
		await page.goto(url, {
			waitUntil: "domcontentloaded",
			timeout: PAGE_LOAD_TIMEOUT
		});
		return;
	} catch (error) {
		console.log(
			`   ⚠️ domcontentloaded待機失敗。loadで再試行: ${error.message}`
		);
	}

	try {
		await page.goto(url, {
			waitUntil: "load",
			timeout: PAGE_LOAD_FALLBACK_TIMEOUT
		});
		console.log("   ✅ load再試行でナビゲーション完了");
		return;
	} catch (error) {
		console.log(`   ⚠️ load再試行も失敗。現在DOMを確認: ${error.message}`);
	}

	if (await hasUsableDom(page)) {
		console.log("   ✅ 描画済みDOMを確認したため撮影前処理を継続");
		return;
	}

	throw new Error("ナビゲーション失敗後も撮影可能なDOMを確認できませんでした");
}

async function scrollForLazyLoad(
	page,
	{
		maxTime = LAZYLOAD_MAX_TIME,
		step = SCROLL_STEP,
		interval = SCROLL_INTERVAL,
		maxDistance = null
	} = {}
) {
	await page.evaluate(
		({ maxTime, step, interval, maxDistance }) =>
			new Promise(resolve => {
				const startedAt = Date.now();
				const startedY = window.scrollY;
				let stalledCount = 0;

				const timer = setInterval(() => {
					const previousY = window.scrollY;
					window.scrollBy(0, step);

					const elapsed = Date.now() - startedAt;
					const distance = window.scrollY - startedY;
					const reachedBottom =
						window.scrollY + window.innerHeight >=
						document.documentElement.scrollHeight - 2;
					stalledCount =
						window.scrollY === previousY ? stalledCount + 1 : 0;
					const stoppedMoving = stalledCount >= 3;
					const reachedDistance =
						maxDistance !== null && distance >= maxDistance;

					if (
						elapsed >= maxTime ||
						reachedBottom ||
						stoppedMoving ||
						reachedDistance
					) {
						clearInterval(timer);
						resolve();
					}
				}, interval);
			}),
		{ maxTime, step, interval, maxDistance }
	);
}

async function waitForImages(page, timeout = IMAGE_WAIT_TIMEOUT) {
	await page.evaluate(timeout => {
		const images = Array.from(document.images);

		return Promise.race([
			Promise.allSettled(
				images.map(image => {
					if (image.complete) {
						return Promise.resolve();
					}

					return new Promise(resolve => {
						const finish = () => resolve();
						image.addEventListener("load", finish, { once: true });
						image.addEventListener("error", finish, { once: true });
						setTimeout(finish, timeout);
					});
				})
			),
			new Promise(resolve => setTimeout(resolve, timeout))
		]);
	}, timeout);
}

async function prepareTopPage(page) {
	await wait(TOP_INITIAL_WAIT);

	try {
		await page.waitForFunction(
			() =>
				document.documentElement.scrollHeight > window.innerHeight &&
				getComputedStyle(document.body).overflow !== "hidden",
			{ timeout: LAZYLOAD_MAX_TIME }
		);
	} catch {
		await page.evaluate(() => {
			const hasScrollableContent =
				document.body.scrollHeight > window.innerHeight ||
				Array.from(document.body.children).some(
					element => element.scrollHeight > window.innerHeight
				);

			if (
				hasScrollableContent &&
				document.documentElement.scrollHeight <= window.innerHeight
			) {
				document.documentElement.style.setProperty(
					"overflow",
					"visible",
					"important"
				);
				document.body.style.setProperty("overflow", "visible", "important");
			}
		});
	}

	await wait(Math.floor(TOP_INITIAL_WAIT / 2));

	await scrollForLazyLoad(page, {
		step: Math.max(80, Math.floor(SCROLL_STEP / 2)),
		interval: SCROLL_INTERVAL * 2
	});
	await waitForImages(page);
	await wait(Math.floor(TOP_INITIAL_WAIT / 2));

	await page.evaluate(() => {
		window.scrollTo(0, 0);
	});
	await wait(SCROLL_INTERVAL * 2);
}

async function prepareForScreenshot(page, pageInfo) {
	if (isTopPage(pageInfo)) {
		await prepareTopPage(page);
		return;
	}

	await scrollForLazyLoad(page);
	await waitForImages(page);
}

async function capturePage(page, { url, outputPath, pageInfo }) {
	await page.bringToFront();

	await gotoWithFallback(page, url);

	await prepareForScreenshot(page, pageInfo);

	await page.screenshot({
		path: outputPath,
		type: "webp",
		quality: 80,
		fullPage: true
	});
}

function saveScreenshotRecord({
	url,
	slug,
	pathname,
	depth,
	pcUIPath,
	spUIPath
}) {
	const existingRecord = db[url] || {};
	const existingMeta = existingRecord.meta || {};
	const existingAssets = existingRecord.assets || {};
	const existingImage = existingAssets.image || {};

	db[url] = {
		...existingRecord,
		meta: {
			...existingMeta,
			url,
			domain,
			slug,
			path: pathname,
			depth,
			capturedAt: new Date().toISOString()
		},
		assets: {
			...existingAssets,
			image: {
				...existingImage,
				pc: pcUIPath,
				sp: spUIPath
			},
			video: existingAssets.video || {
				pc: null,
				sp: null
			},
			thumb: existingAssets.thumb || {
				pc: null,
				sp: null
			}
		},
		analysis: existingRecord.analysis || {
			needsVideo: false,
			animationHeavy: false,
			hasWebGL: false,
			hasScrollTrigger: false,
			checked: {
				auto: false,
				manual: false
			}
		},
		tags: existingRecord.tags || []
	};
}

// ---------------------------------------
// メイン処理
// ---------------------------------------
(async () => {
	const browser = await puppeteer.launch({ headless: true });

	try {
		const pagePC = await browser.newPage();
		const pageSP = await browser.newPage();

		await pagePC.setUserAgent(
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
		);
		await pagePC.setViewport({ width: 1280, height: 900 });

		await pageSP.setUserAgent(
			"Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile Safari/604.1"
		);
		await pageSP.setViewport({ width: 390, height: 844 });

		let count = 0;

		for (const url of urls) {
			count++;

			const urlObj = new URL(url);
			const slug = toSafeSlug(url);
			const pathname = urlObj.pathname;
			const depth = pathname.split("/").filter(Boolean).length;
			const pageInfo = { slug, pathname, depth };

			const saveDir = path.join("screenshots", domain, slug);
			const baseName = `${domain}_${slug}`;

			const pcFsPath = path.join(saveDir, `${baseName}_pc.webp`);
			const spFsPath = path.join(saveDir, `${baseName}_sp.webp`);

			const pcUIPath = `../${pcFsPath.replace(/\\/g, "/")}`;
			const spUIPath = `../${spFsPath.replace(/\\/g, "/")}`;

			const hasPC = fs.existsSync(pcFsPath);
			const hasSP = fs.existsSync(spFsPath);

			if (hasPC && hasSP) {
				console.log(`⏭ (${count}/${urls.length}) スキップ: ${url}`);
				continue;
			}

			console.log(`📸 (${count}/${urls.length}) 撮影中: ${url}`);
			fs.mkdirSync(saveDir, { recursive: true });

			if (!hasPC) {
				try {
					await capturePage(pagePC, {
						url,
						outputPath: pcFsPath,
						pageInfo
					});
				} catch (error) {
					console.log("   ❌ PC失敗:", error.message);
				}
			}

			if (!hasSP) {
				try {
					await capturePage(pageSP, {
						url,
						outputPath: spFsPath,
						pageInfo
					});
				} catch (error) {
					console.log("   ❌ SP失敗:", error.message);
				}
			}

			if (fs.existsSync(pcFsPath) || fs.existsSync(spFsPath)) {
				saveScreenshotRecord({
					url,
					slug,
					pathname,
					depth,
					pcUIPath,
					spUIPath
				});
			}
		}
	} finally {
		await browser.close();
		fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
	}

	console.log("\n💾 保存:", DB_FILE);
	console.log("✅ 完了！");
})().catch(error => {
	console.error("❌ バッチ処理に失敗しました:", error);
	process.exitCode = 1;
});
