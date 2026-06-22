const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

/**
 * ============================================================
 * record_top.js — TOPページ動画録画 PoC
 * ------------------------------------------------------------
 * 静止画では拾えないTOPの動き（ヒーロー動画・スクロール演出）を
 * 自動スクロール録画して mp4 で保存し、既存 screenshots_db /
 * gallery スキーマに統合する。
 *
 * 使い方:
 *   node record_top.js https://hikarina.co.jp/
 *
 * 保存先（既存構造に合わせる）:
 *   screenshots/<domain>/top/<domain>_top_pc.mp4
 *   screenshots/<domain>/top/<domain>_top_sp.mp4
 *
 * DB 書き戻し（既存値は壊さない）:
 *   screenshots_db/<domain>.json の対象URLキーに
 *   assets.video.pc / assets.video.sp（gallery相対パス）を追記。
 *   assets.image / assets.thumb / tags / _site.tags / analysis は保持。
 *   analysis.needsVideo = true。
 *
 * 依存:
 *   page.screencast()（Puppeteer ネイティブ）+ ffmpeg。
 *   ffmpeg は ffmpeg-static があればそれを、無ければ PATH の ffmpeg を使う。
 * ============================================================
 */

// ffmpeg を PATH に通す（page.screencast は "ffmpeg" を spawn する）
try {
	const ffmpegPath = require("ffmpeg-static");
	if (ffmpegPath) {
		process.env.PATH = path.dirname(ffmpegPath) + path.delimiter + process.env.PATH;
	}
} catch {
	// ffmpeg-static 未導入ならシステムの ffmpeg を期待
}

// ---------------------------------------
// 設定
// ---------------------------------------
const PAGE_LOAD_TIMEOUT = 30000;
const PAGE_LOAD_FALLBACK_TIMEOUT = 15000;
const HERO_WAIT = 3000;
const LAZYLOAD_MAX_TIME = 8000;
const IMAGE_WAIT_TIMEOUT = 5000;

const SCROLL_DURATION = 12000; // 下までスクロールに掛ける目安(ms)
const SCROLL_STEP_INTERVAL = 120; // スクロール1ステップ間隔(ms)
const HOLD_TOP = 1000; // 録画開始直後にヒーローを見せる時間
const HOLD_BOTTOM = 800; // 最下部での静止時間

const VIEWPORTS = {
	pc: {
		width: 1280,
		height: 900,
		userAgent:
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
	},
	sp: {
		width: 390,
		height: 844,
		userAgent:
			"Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile Safari/604.1"
	}
};

// ---------------------------------------
// 引数
// ---------------------------------------
const TARGET_URL = process.argv[2];
if (!TARGET_URL) {
	console.error("❌ URL を指定してください");
	console.error("   例: node record_top.js https://hikarina.co.jp/");
	process.exit(1);
}

let urlObj;
try {
	urlObj = new URL(TARGET_URL);
} catch {
	console.error("❌ URL が不正です:", TARGET_URL);
	process.exit(1);
}

const domain = urlObj.hostname.replace(/\./g, "_");
const slug = "top";
const saveDir = path.join("screenshots", domain, slug);
const baseName = `${domain}_${slug}`;
const pcFsPath = path.join(saveDir, `${baseName}_pc.mp4`);
const spFsPath = path.join(saveDir, `${baseName}_sp.mp4`);
const pcUIPath = `../${pcFsPath.replace(/\\/g, "/")}`;
const spUIPath = `../${spFsPath.replace(/\\/g, "/")}`;
const DB_FILE = `./screenshots_db/${domain}.json`;

// ---------------------------------------
// ユーティリティ
// ---------------------------------------
function wait(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

async function gotoWithFallback(page, url) {
	try {
		await page.goto(url, { waitUntil: "domcontentloaded", timeout: PAGE_LOAD_TIMEOUT });
		await page.waitForNetworkIdle({ idleTime: 600, timeout: 6000 }).catch(() => {});
		return;
	} catch (error) {
		console.log(`   ⚠️ domcontentloaded失敗。loadで再試行: ${error.message}`);
	}
	await page.goto(url, { waitUntil: "load", timeout: PAGE_LOAD_FALLBACK_TIMEOUT });
}

async function waitForImages(page, timeout = IMAGE_WAIT_TIMEOUT) {
	await page.evaluate(timeout => {
		const images = Array.from(document.images);
		return Promise.race([
			Promise.allSettled(
				images.map(image =>
					image.complete
						? Promise.resolve()
						: new Promise(resolve => {
								image.addEventListener("load", resolve, { once: true });
								image.addEventListener("error", resolve, { once: true });
								setTimeout(resolve, timeout);
						  })
				)
			),
			new Promise(resolve => setTimeout(resolve, timeout))
		]);
	}, timeout);
}

// 録画前準備: ヒーロー待ち → lazyload発火 → 先頭へ戻す
async function preparePage(page) {
	await wait(HERO_WAIT);
	await page.evaluate(
		maxTime =>
			new Promise(resolve => {
				const start = Date.now();
				const timer = setInterval(() => {
					window.scrollBy(0, 400);
					const bottom =
						window.scrollY + window.innerHeight >=
						document.documentElement.scrollHeight - 2;
					if (bottom || Date.now() - start > maxTime) {
						clearInterval(timer);
						resolve();
					}
				}, 100);
			}),
		LAZYLOAD_MAX_TIME
	);
	await waitForImages(page);
	await page.evaluate(() => window.scrollTo(0, 0));
	await wait(500);
}

// 自動スクロール（録画中に呼ぶ）: 先頭 → 最下部
async function autoScrollDown(page, durationMs = SCROLL_DURATION) {
	await page.evaluate(() => window.scrollTo(0, 0));
	const metrics = await page.evaluate(() => ({
		total: document.documentElement.scrollHeight,
		vh: window.innerHeight
	}));
	const distance = Math.max(0, metrics.total - metrics.vh);
	if (distance === 0) {
		await wait(durationMs);
		return;
	}
	const steps = Math.max(1, Math.round(durationMs / SCROLL_STEP_INTERVAL));
	const per = distance / steps;
	for (let i = 1; i <= steps; i++) {
		await page.evaluate(y => window.scrollTo(0, y), Math.round(per * i));
		await wait(SCROLL_STEP_INTERVAL);
	}
}

async function recordViewport(browser, key) {
	const vp = VIEWPORTS[key];
	const outPath = key === "pc" ? pcFsPath : spFsPath;

	const page = await browser.newPage();
	try {
		await page.setUserAgent(vp.userAgent);
		await page.setViewport({ width: vp.width, height: vp.height });

		console.log(`🎬 [${key.toUpperCase()}] 録画準備: ${TARGET_URL}`);
		await gotoWithFallback(page, TARGET_URL);
		await preparePage(page);

		const recorder = await page.screencast({ path: outPath });
		await wait(HOLD_TOP); // ヒーロー静止（動画ヒーローの再生を見せる）
		await autoScrollDown(page); // スクロール演出
		await wait(HOLD_BOTTOM);
		await recorder.stop();

		const bytes = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0;
		console.log(`   ✅ [${key.toUpperCase()}] 保存: ${outPath} (${(bytes / 1024).toFixed(0)}KB)`);
		return bytes > 0;
	} catch (error) {
		console.log(`   ❌ [${key.toUpperCase()}] 録画失敗: ${error.message}`);
		return false;
	} finally {
		await page.close().catch(() => {});
	}
}

// ---------------------------------------
// DB 書き戻し（既存スキーマを壊さない）
// ---------------------------------------
function writeBackDb({ pcOk, spOk }) {
	let db = {};
	if (fs.existsSync(DB_FILE)) {
		db = JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
	}

	const existingRecord = db[TARGET_URL] || {};
	const existingMeta = existingRecord.meta || {};
	const existingAssets = existingRecord.assets || {};
	const existingVideo = existingAssets.video || { pc: null, sp: null };
	const existingAnalysis = existingRecord.analysis || {};

	const depth = urlObj.pathname.split("/").filter(Boolean).length;

	db[TARGET_URL] = {
		...existingRecord,
		meta: {
			url: TARGET_URL,
			domain,
			slug,
			path: urlObj.pathname,
			depth,
			...existingMeta // 既存metaを優先保持。capturedAtは静止画側の値を尊重
		},
		assets: {
			...existingAssets,
			image: existingAssets.image || { pc: null, sp: null },
			thumb: existingAssets.thumb || { pc: null, sp: null },
			video: {
				...existingVideo,
				pc: pcOk ? pcUIPath : existingVideo.pc,
				sp: spOk ? spUIPath : existingVideo.sp
			}
		},
		analysis: {
			...existingAnalysis,
			needsVideo: true
		},
		tags: existingRecord.tags || []
	};

	fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
	console.log("💾 DB更新:", DB_FILE);
	console.log("   assets.video.pc =", db[TARGET_URL].assets.video.pc);
	console.log("   assets.video.sp =", db[TARGET_URL].assets.video.sp);
}

// ---------------------------------------
// メイン
// ---------------------------------------
(async () => {
	fs.mkdirSync(saveDir, { recursive: true });
	fs.mkdirSync("./screenshots_db", { recursive: true });

	const browser = await puppeteer.launch({
		headless: true,
		acceptInsecureCerts: true,
		args: ["--no-sandbox", "--disable-setuid-sandbox"]
	});

	let pcOk = false;
	let spOk = false;
	try {
		pcOk = await recordViewport(browser, "pc");
		spOk = await recordViewport(browser, "sp");
	} finally {
		await browser.close();
	}

	if (pcOk || spOk) {
		writeBackDb({ pcOk, spOk });
	} else {
		console.log("⚠️ PC/SPとも録画できなかったため DB は更新しません");
		process.exitCode = 1;
	}

	console.log("✅ 完了！");
})().catch(error => {
	console.error("❌ 録画処理に失敗:", error);
	process.exitCode = 1;
});
